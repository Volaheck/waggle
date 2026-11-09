import { createHmac } from "node:crypto";
import { serve } from "@hono/node-server";
import { AvatarCache } from "./api/avatars.js";
import { createApi } from "./api/server.js";
import { ALLOWED_UPDATES, createBot, notifyAdmins, registerCommands } from "./bot/bot.js";
import { startNameSync } from "./bot/names.js";
import { telegramWebhook } from "./bot/webhook.js";
import { relinkForeignTopics } from "./core/chronicle.js";
import { loadConfig } from "./core/config.js";
import { createSql, migrate } from "./core/db.js";
import { chatEndUserId, createAnthropic, isPricedModel } from "./core/llm.js";
import { INTERRUPTED_PASS_ERROR } from "./worker/extract.js";
import { startExtractionScheduler, startMessageRetention } from "./worker/scheduler.js";

// A stop waits this long for work already under way; all of it together stays below stop_grace_period in docker-compose.yml.
const PASS_WAIT_MS = 40_000;
/** How long a stop waits for answers to mentions under way (a Haiku call takes a few seconds). */
const REPLIES_WAIT_MS = 10_000;
/** After PASS_WAIT_MS the chronicler call under way is cancelled; this is how long winding it down may take. */
const CANCEL_WAIT_MS = 5_000;
const POLLING_STOP_WAIT_MS = 5_000;
const WEBHOOK_UPDATES_WAIT_MS = 8_000;

/** True when all of `work` settled within `ms`. */
async function settledWithin(ms: number, work: unknown[]): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), ms)));
  const settled = await Promise.race([Promise.allSettled(work).then(() => true as const), timeout]);
  clearTimeout(timer);
  return settled;
}

const config = loadConfig();
const sql = createSql(config.DATABASE_URL);

const applied = await migrate(sql);
if (applied.length) console.log(`[db] applied migrations: ${applied.join(", ")}`);

// Only this process runs chronicler passes, so a run still marked running was cut off when the previous process
// stopped. Marked failed, it shows up in /botstatus, and the scheduler waits before paying for that batch again.
const interrupted = await sql`
  UPDATE extraction_runs SET status = 'failed', finished_at = now(), error = ${INTERRUPTED_PASS_ERROR}
  WHERE status = 'running'
  RETURNING id`;
if (interrupted.length) console.warn(`[extract] ${interrupted.length} pass(es) were cut off by the previous stop; marked as failed`);

// Topics an earlier version linked to another chat's project point at the chat's own project from now on.
const relinked = await relinkForeignTopics(sql);
if (relinked) console.log(`[extract] relinked ${relinked} chronicle topic(s) that pointed to another chat's project`);

for (const [name, model] of [
  ["EXTRACTION_MODEL", config.EXTRACTION_MODEL],
  ["REPLY_MODEL", config.REPLY_MODEL],
  ["REPLY_PREMIUM_MODEL", config.REPLY_PREMIUM_MODEL],
] as const) {
  if (config.ANTHROPIC_API_KEY && !isPricedModel(model)) console.warn(`[llm] no price known for ${name} “${model}”: its calls are counted at the highest known rates`);
}

const anthropic = config.ANTHROPIC_API_KEY ? createAnthropic(config.ANTHROPIC_API_KEY) : undefined;
const { bot, membership, assistant, interjector, onJoined } = createBot({ sql, config, anthropic });
await bot.init();
// With sql, owners removed from ADMIN_TG_IDS also lose their owner command menu.
await registerCommands(bot, config.ADMIN_TG_IDS, sql).catch((error) => console.warn("[bot] could not register commands:", error));

// Derived from the bot token so the link survives dev-server restarts, yet stays as secret as the token itself.
const devLogin = config.DEV_BROWSER_LOGIN
  ? { token: createHmac("sha256", config.BOT_TOKEN).update("dev-browser-login").digest("base64url").slice(0, 24), loginAs: config.DEV_LOGIN_AS }
  : undefined;

const app = createApi({
  sql,
  botToken: config.BOT_TOKEN,
  adminTgIds: config.ADMIN_TG_IDS,
  isMember: (chatId, tgUserId) => membership.isMember(chatId, tgUserId),
  onJoined,
  webDistDir: config.WEB_DIST_DIR,
  devLogin,
  avatars: new AvatarCache(bot.api, config.BOT_TOKEN),
});

const webhook = config.BOT_MODE === "webhook" ? telegramWebhook(bot, config.WEBHOOK_SECRET!) : undefined;
if (webhook) app.post("/telegram/webhook", (c) => webhook.handle(c.req.raw));

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`[http] listening on :${info.port}`);
  if (devLogin) console.log(`[dev] browser login (as «${devLogin.loginAs || "first admin"}»): http://localhost:${info.port}/app/?dev=${devLogin.token}`);
});

if (webhook) {
  await bot.api.setWebhook(`${config.PUBLIC_URL!.replace(/\/$/, "")}/telegram/webhook`, {
    secret_token: config.WEBHOOK_SECRET,
    allowed_updates: [...ALLOWED_UPDATES],
  });
  console.log("[bot] webhook set");
} else {
  await bot.api.deleteWebhook();
  void bot.start({ allowed_updates: [...ALLOWED_UPDATES], onStart: (info) => console.log(`[bot] @${info.username} is listening (long polling)`) });
}

const stopScheduler = anthropic
  ? startExtractionScheduler({
      sql,
      anthropic,
      config,
      notifyAdmins: (text, offer) => notifyAdmins(bot, sql, config.ADMIN_TG_IDS, text, offer),
      endUserIdOf: (chatId) => chatEndUserId(config.BOT_TOKEN, chatId),
    })
  : (console.warn("[extract] ANTHROPIC_API_KEY is not set — the chronicler is off; the bot still serves the archive and manual data"),
    async (_graceMs?: number) => {});

const stopRetention = startMessageRetention(sql, config.MESSAGE_RETENTION_DAYS);
const stopNameSync = startNameSync(bot.api, sql, config.ADMIN_TG_IDS);
if (config.ADMIN_TG_IDS.length === 0) {
  console.warn("[bot] ADMIN_TG_IDS is empty — nobody can approve new chats. Get your Telegram ID from a bot like @userinfobot and add it to ADMIN_TG_IDS.");
}

const shutdown = async (signal: string) => {
  console.log(`[main] ${signal}, shutting down`);
  stopNameSync();
  stopRetention();
  // The bot does not start speaking up uninvited any more; a check under way finishes with the answers below.
  interjector?.stop();
  // The bot keeps serving while the chronicler call under way finishes; no new call starts. A call that takes longer
  // is cancelled with its usage so far recorded, and the pass continues after the restart (batches are applied whole).
  if (!(await settledWithin(PASS_WAIT_MS + CANCEL_WAIT_MS, [stopScheduler(PASS_WAIT_MS)]))) {
    console.warn(`[main] the chronicler did not wind down within ${(PASS_WAIT_MS + CANCEL_WAIT_MS) / 1000} s; stopping anyway`);
  }
  if (config.BOT_MODE === "polling") {
    await settledWithin(POLLING_STOP_WAIT_MS, [bot.stop().catch((error) => console.warn("[bot] could not stop long polling cleanly:", error))]);
  }
  server.close();
  if (webhook && !(await settledWithin(WEBHOOK_UPDATES_WAIT_MS, [webhook.settle()]))) console.warn("[main] some updates are still being handled; stopping anyway");
  // Answers to mentions already under way, and an interjection being checked, are sent before the database closes.
  if (assistant && !(await settledWithin(REPLIES_WAIT_MS, [assistant.idle(), interjector?.idle()]))) {
    console.warn("[main] some answers to mentions did not finish; stopping anyway");
  }
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
