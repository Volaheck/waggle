import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { Bot, BotError } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { telegramWebhook } from "../src/bot/webhook.js";
import { loadConfig, resetConfigForTests } from "../src/core/config.js";

const REQUIRED = { BOT_TOKEN: "123456:abcdefghij", DATABASE_URL: "postgres://u:p@localhost/db" };

describe("loadConfig", () => {
  beforeEach(() => resetConfigForTests());
  afterEach(() => resetConfigForTests());

  it("starts from .env.example once the required keys are filled in", () => {
    const example = parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));
    const config = loadConfig({ ...example, ...REQUIRED });
    expect(config.BOT_MODE).toBe("polling");
    expect(config.PUBLIC_URL).toBeUndefined();
    expect(config.WEBHOOK_SECRET).toBeUndefined();
    expect(config.BOT_APP_SHORT_NAME).toBeUndefined();
    expect(config.MESSAGE_RETENTION_DAYS).toBe(7);
    expect(config.INTERJECTIONS_PER_CHAT_PER_DAY).toBe(3);
    expect(config.INTERJECTION_MIN_GAP_HOURS).toBe(3);
  });

  it("treats keys left blank in .env as not set, so defaults apply", () => {
    const config = loadConfig({
      ...REQUIRED,
      PUBLIC_URL: "",
      WEBHOOK_SECRET: "  ",
      BOT_APP_SHORT_NAME: "",
      ANTHROPIC_API_KEY: "",
      ADMIN_TG_IDS: "",
      BOT_MODE: "",
      PORT: "",
      EXTRACTION_INTERVAL_HOURS: "",
      MESSAGE_RETENTION_DAYS: "",
      DEV_BROWSER_LOGIN: "",
    });
    expect(config.PUBLIC_URL).toBeUndefined();
    expect(config.WEBHOOK_SECRET).toBeUndefined();
    expect(config.ANTHROPIC_API_KEY).toBeUndefined();
    expect(config.ADMIN_TG_IDS).toEqual([]);
    expect(config.BOT_MODE).toBe("polling");
    expect(config.PORT).toBe(8787);
    expect(config.EXTRACTION_INTERVAL_HOURS).toBe(6);
    expect(config.MESSAGE_RETENTION_DAYS).toBe(7);
    expect(config.DEV_BROWSER_LOGIN).toBe(false);
  });

  it("still rejects a value that is set but wrong", () => {
    expect(() => loadConfig({ ...REQUIRED, PUBLIC_URL: "waggle.example.com" })).toThrow(/PUBLIC_URL/);
    expect(() => loadConfig({ ...REQUIRED, WEBHOOK_SECRET: "short" })).toThrow(/WEBHOOK_SECRET/);
    for (const days of ["0", "-3", "1.5", "a week"]) {
      resetConfigForTests();
      expect(() => loadConfig({ ...REQUIRED, MESSAGE_RETENTION_DAYS: days }), days).toThrow(/MESSAGE_RETENTION_DAYS/);
    }
  });

  it("reads the message retention in whole days", () => {
    expect(loadConfig({ ...REQUIRED, MESSAGE_RETENTION_DAYS: "30" }).MESSAGE_RETENTION_DAYS).toBe(30);
  });

  it("still requires PUBLIC_URL and WEBHOOK_SECRET in webhook mode, blank or not", () => {
    expect(() => loadConfig({ ...REQUIRED, BOT_MODE: "webhook", PUBLIC_URL: "", WEBHOOK_SECRET: "" })).toThrow(
      "BOT_MODE=webhook requires PUBLIC_URL and WEBHOOK_SECRET",
    );
  });
});

describe("telegramWebhook", () => {
  const SECRET = "s3cret-token-of-sixteen-chars";
  const botInfo: UserFromGetMe = {
    id: 42,
    is_bot: true,
    first_name: "Waggle",
    username: "waggle_test_bot",
    can_join_groups: true,
    can_read_all_group_messages: true,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };
  const update = (updateId: number): Update => ({
    update_id: updateId,
    message: { message_id: updateId, date: 0, chat: { id: 7, type: "private", first_name: "Ann" }, from: { id: 7, is_bot: false, first_name: "Ann" }, text: "hi" },
  });
  const post = (body: unknown, secret: string | null = SECRET) =>
    new Request("http://localhost/telegram/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", ...(secret === null ? {} : { "x-telegram-bot-api-secret-token": secret }) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  afterEach(() => vi.restoreAllMocks());

  it("turns away requests without Telegram's secret token", async () => {
    const bot = new Bot("123456:abcdefghij", { botInfo });
    const seen = vi.fn();
    bot.on("message", seen);
    const webhook = telegramWebhook(bot, SECRET);
    expect((await webhook.handle(post(update(1), null))).status).toBe(401);
    expect((await webhook.handle(post(update(2), "s3cret-token-of-sixteen-chaRS"))).status).toBe(401);
    expect((await webhook.handle(post(update(3), "short"))).status).toBe(401);
    expect(seen).not.toHaveBeenCalled();
    expect((await webhook.handle(post(update(4)))).status).toBe(200);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("passes a failing update to bot.catch and still answers 200, so Telegram does not deliver it again", async () => {
    const bot = new Bot("123456:abcdefghij", { botInfo });
    bot.on("message", () => {
      throw new Error("boom");
    });
    const caught: BotError[] = [];
    bot.catch((error) => void caught.push(error));
    const webhook = telegramWebhook(bot, SECRET);

    const response = await webhook.handle(post(update(5)));
    expect(response.status).toBe(200);
    expect(caught).toHaveLength(1);
    expect(caught[0]!.ctx.update.update_id).toBe(5);
    expect((caught[0]!.error as Error).message).toBe("boom");
  });

  it("answers 200 even when the error handler itself throws", async () => {
    const bot = new Bot("123456:abcdefghij", { botInfo });
    bot.on("message", () => {
      throw new Error("boom");
    });
    bot.catch(() => {
      throw new Error("handler broke too");
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const webhook = telegramWebhook(bot, SECRET);

    expect((await webhook.handle(post(update(6)))).status).toBe(200);
    expect(logged).toHaveBeenCalledWith("[bot] update 6 failed:", expect.any(Error));
  });

  it("answers a slow update in time and lets settle() wait for it to finish", async () => {
    const bot = new Bot("123456:abcdefghij", { botInfo });
    let finish!: () => void;
    const finished = vi.fn();
    bot.on("message", async () => {
      await new Promise<void>((resolve) => (finish = resolve));
      finished();
    });
    const webhook = telegramWebhook(bot, SECRET, 20);

    const response = await webhook.handle(post(update(7)));
    expect(response.status).toBe(200);
    expect(finished).not.toHaveBeenCalled();

    let settled = false;
    const settling = webhook.settle().then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    finish();
    await settling;
    expect(finished).toHaveBeenCalledTimes(1);
  });

  it("rejects a body that is not JSON", async () => {
    const bot = new Bot("123456:abcdefghij", { botInfo });
    const webhook = telegramWebhook(bot, SECRET);
    expect((await webhook.handle(post("not json"))).status).toBe(400);
  });
});
