import { createHmac } from "node:crypto";
import { serve } from "@hono/node-server";
import { webhookCallback } from "grammy";
import { createApi } from "./api/server.js";
import { ALLOWED_UPDATES, createBot, notifyAdmins, registerCommands } from "./bot/bot.js";
import { startNameSync } from "./bot/names.js";
import { loadConfig } from "./core/config.js";
import { createSql, migrate } from "./core/db.js";
import { createAnthropic } from "./core/llm.js";
import { startExtractionScheduler } from "./worker/scheduler.js";

const config = loadConfig();
const sql = createSql(config.DATABASE_URL);

const applied = await migrate(sql);
if (applied.length) console.log(`[db] applied migrations: ${applied.join(", ")}`);

const { bot, membership } = createBot({ sql, config });
await bot.init();
await registerCommands(bot, config.ADMIN_TG_IDS).catch((error) => console.warn("[bot] could not register commands:", error));

// Derived from the bot token so the link survives dev-server restarts, yet stays as secret as the token itself.
const devLogin = config.DEV_BROWSER_LOGIN
  ? { token: createHmac("sha256", config.BOT_TOKEN).update("dev-browser-login").digest("base64url").slice(0, 24), loginAs: config.DEV_LOGIN_AS }
  : undefined;

const app = createApi({
  sql,
  botToken: config.BOT_TOKEN,
  adminTgIds: config.ADMIN_TG_IDS,
  isMember: (chatId, tgUserId) => membership.isMember(chatId, tgUserId),
  webDistDir: config.WEB_DIST_DIR,
  devLogin,
});

if (config.BOT_MODE === "webhook") {
  const handleUpdate = webhookCallback(bot, "hono", { secretToken: config.WEBHOOK_SECRET });
  app.post("/telegram/webhook", (c) => handleUpdate(c));
}

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`[http] listening on :${info.port}`);
  if (devLogin) console.log(`[dev] browser login (as «${devLogin.loginAs || "first admin"}»): http://localhost:${info.port}/app/?dev=${devLogin.token}`);
});

if (config.BOT_MODE === "webhook") {
  await bot.api.setWebhook(`${config.PUBLIC_URL!.replace(/\/$/, "")}/telegram/webhook`, {
    secret_token: config.WEBHOOK_SECRET,
    allowed_updates: [...ALLOWED_UPDATES],
  });
  console.log("[bot] webhook set");
} else {
  await bot.api.deleteWebhook();
  void bot.start({ allowed_updates: [...ALLOWED_UPDATES], onStart: (info) => console.log(`[bot] @${info.username} is listening (long polling)`) });
}

const stopScheduler = config.ANTHROPIC_API_KEY
  ? startExtractionScheduler({
      sql,
      anthropic: createAnthropic(config.ANTHROPIC_API_KEY),
      config,
      notifyAdmins: (text) => notifyAdmins(bot, sql, config.ADMIN_TG_IDS, text),
    })
  : (console.warn("[extract] ANTHROPIC_API_KEY is not set — the chronicler is off; the bot still serves the archive and manual data"), () => {});

const stopNameSync = startNameSync(bot.api, sql, config.ADMIN_TG_IDS);
if (config.ADMIN_TG_IDS.length === 0) console.warn("[bot] ADMIN_TG_IDS is empty — nobody can approve new chats. Message the bot to learn your Telegram ID.");

const shutdown = async (signal: string) => {
  console.log(`[main] ${signal}, shutting down`);
  stopScheduler();
  stopNameSync();
  if (config.BOT_MODE === "polling") await bot.stop();
  server.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
