import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createBot } from "../src/bot/bot.js";
import { deletedReport, editedReport } from "../src/bot/business.js";
import { clearExpiredBusinessMessages, type BusinessMessage } from "../src/core/business.js";
import type { Config } from "../src/core/config.js";
import { createSql, migrate, type Sql } from "../src/core/db.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const TOKEN = "123456:TEST-TOKEN";
const OWNER = 9000;
const STRANGER = 9500;
const FRIEND = { id: 7001, is_bot: false, first_name: "Anna", last_name: "K" };

const kept = (overrides: Partial<BusinessMessage>): BusinessMessage => ({
  connectionId: "c",
  chatId: FRIEND.id,
  msgId: 1,
  fromTgId: FRIEND.id,
  fromName: "Anna",
  text: "",
  mediaKind: null,
  fileId: null,
  sentAt: new Date("2026-11-09T12:00:00Z"),
  editedAt: null,
  ...overrides,
});

describe("business reports", () => {
  it("quote what was deleted, escaped, and stop before Telegram's limit", () => {
    const report = deletedReport("Anna <K>", [kept({ text: "<b>gone</b>" }), kept({ msgId: 2, mediaKind: "photo", fileId: "f", text: "caption" })], "UTC");
    expect(report).toContain("Anna &lt;K&gt;");
    expect(report).toContain("<blockquote>&lt;b&gt;gone&lt;/b&gt;</blockquote>");
    expect(report).toContain("<blockquote>[photo] caption</blockquote>");
    const many = Array.from({ length: 20 }, (_, index) => kept({ msgId: index, text: "x".repeat(900) }));
    const long = deletedReport("Anna", many, "UTC");
    expect(long.length).toBeLessThan(4096);
    expect(long).toMatch(/…and \d+ more messages$/);
    expect(long.split("<blockquote>").length).toBe(long.split("</blockquote>").length);
  });

  it("show both versions of an edit", () => {
    const report = editedReport(kept({ text: "see you at 5" }), kept({ text: "see you at 6" }), "UTC");
    expect(report).toMatch(/Was:\n<blockquote>see you at 5<\/blockquote>\nNow:\n<blockquote>see you at 6<\/blockquote>/);
  });
});

describe.skipIf(!DATABASE_URL)("deleted and edited messages in owners' private chats", () => {
  let sql: Sql;
  let updateId = 1;
  const calls: { method: string; payload: Record<string, any> }[] = [];
  const connections = new Map<string, { userId: number; enabled: boolean }>();
  const config = {
    BOT_TOKEN: TOKEN, ADMIN_TG_IDS: [OWNER], DATABASE_URL: DATABASE_URL!, BOT_MODE: "polling", PORT: 0, EXTRACTION_MODEL: "x", EXTRACTION_INTERVAL_HOURS: 6, MESSAGE_RETENTION_DAYS: 7,
    DISPLAY_TIMEZONE: "UTC", MONTHLY_LLM_BUDGET_USD: 60, CHAT_MONTHLY_BUDGET_USD: 20, WEB_DIST_DIR: "web/dist", DEV_BROWSER_LOGIN: false, DEV_LOGIN_AS: "", BUSINESS_MESSAGE_RETENTION_DAYS: 30,
  } as unknown as Config;
  const connectionObject = (id: string) => {
    const known = connections.get(id)!;
    return { id, user: { id: known.userId, is_bot: false, first_name: "Me" }, user_chat_id: known.userId, date: 0, is_enabled: known.enabled };
  };
  const fakeApi = async (_prev: unknown, method: string, payload: Record<string, any>) => {
    calls.push({ method, payload });
    if (method === "getBusinessConnection") return { ok: true, result: connectionObject(payload.business_connection_id) };
    if (method.startsWith("send")) return { ok: true, result: { message_id: 1, date: 0, chat: { id: payload.chat_id, type: "private", first_name: "x" } } };
    return { ok: true, result: true };
  };
  let bot: ReturnType<typeof createBot>["bot"];
  const now = () => Math.floor(Date.now() / 1000);
  const chat = { id: FRIEND.id, type: "private", first_name: "Anna", last_name: "K" };

  const connect = (id: string, userId: number, enabled = true) => {
    connections.set(id, { userId, enabled });
    return bot.handleUpdate({ update_id: updateId++, business_connection: connectionObject(id) } as never);
  };
  const incoming = (connectionId: string, messageId: number, content: Record<string, unknown>, from: Record<string, unknown> = FRIEND) =>
    bot.handleUpdate({ update_id: updateId++, business_message: { business_connection_id: connectionId, message_id: messageId, date: now(), chat, from, ...content } } as never);
  const edited = (connectionId: string, messageId: number, content: Record<string, unknown>) =>
    bot.handleUpdate({
      update_id: updateId++,
      edited_business_message: { business_connection_id: connectionId, message_id: messageId, date: now() - 60, edit_date: now(), chat, from: FRIEND, ...content },
    } as never);
  const deleted = (connectionId: string, messageIds: number[]) =>
    bot.handleUpdate({ update_id: updateId++, deleted_business_messages: { business_connection_id: connectionId, chat, message_ids: messageIds } } as never);
  const sentTexts = () => calls.filter((call) => call.method === "sendMessage").map((call) => String(call.payload.text));
  const keptIds = async (connectionId: string) =>
    (await sql<{ msg_id: number }[]>`SELECT msg_id FROM business_messages WHERE connection_id = ${connectionId} ORDER BY msg_id`).map((row) => row.msg_id);

  beforeAll(async () => {
    sql = createSql(DATABASE_URL!);
    await sql`DROP SCHEMA public CASCADE`;
    await sql`CREATE SCHEMA public`;
    await migrate(sql);
    bot = createBot({ sql, config }).bot;
    bot.botInfo = { id: 1, is_bot: true, first_name: "Waggle", username: "waggle_bot" } as typeof bot.botInfo;
    bot.api.config.use(fakeApi as never);
  });

  afterAll(async () => {
    await sql?.end();
  });

  beforeEach(() => {
    calls.length = 0;
  });

  it("greets an owner who connects the bot and keeps only the other side's messages", async () => {
    await connect("own", OWNER);
    expect(sentTexts()).toEqual([expect.stringContaining("Connected")]);
    expect(calls[0]!.payload.chat_id).toBe(OWNER);

    await incoming("own", 10, { text: "hi" });
    await incoming("own", 11, { photo: [{ file_id: "small", file_unique_id: "s", width: 1, height: 1 }, { file_id: "big", file_unique_id: "b", width: 9, height: 9 }], caption: "look" });
    await incoming("own", 12, { text: "my own words" }, { id: OWNER, is_bot: false, first_name: "Me" });
    expect(await keptIds("own")).toEqual([10, 11]);
    // The group side never sees these messages.
    expect((await sql`SELECT count(*)::int AS n FROM messages`)[0]!.n).toBe(0);
  });

  it("reports an edit with both versions, and stays quiet when nothing changed", async () => {
    await edited("own", 10, { text: "hi there" });
    expect(sentTexts()).toEqual([expect.stringMatching(/Anna K<\/b> edited a message[\s\S]*<blockquote>hi<\/blockquote>[\s\S]*<blockquote>hi there<\/blockquote>/)]);
    calls.length = 0;
    await edited("own", 10, { text: "hi there" });
    expect(calls).toEqual([]);
  });

  it("reports deleted messages and sends deleted photos back", async () => {
    await deleted("own", [10, 11, 12, 999]);
    expect(sentTexts()).toEqual([expect.stringMatching(/Deleted in the chat with <b>Anna K<\/b>[\s\S]*hi there[\s\S]*\[photo\] look/)]);
    const photo = calls.find((call) => call.method === "sendPhoto");
    expect(photo?.payload).toMatchObject({ chat_id: OWNER, photo: "big" });
    expect(await keptIds("own")).toEqual([]);
  });

  it("keeps nothing for someone who is not an owner", async () => {
    await connect("other", STRANGER);
    expect(sentTexts()).toEqual([expect.stringContaining("only for its owners")]);
    await incoming("other", 20, { text: "secret" });
    await deleted("other", [20]);
    expect(await keptIds("other")).toEqual([]);
    expect(sentTexts()).toHaveLength(1);
  });

  it("looks up a connection made before the bot listened, then keeps its messages", async () => {
    connections.set("early", { userId: OWNER, enabled: true });
    await incoming("early", 30, { text: "before the update" });
    expect(calls.some((call) => call.method === "getBusinessConnection")).toBe(true);
    expect(await keptIds("early")).toEqual([30]);
  });

  it("deletes what it kept once the owner disconnects", async () => {
    await incoming("own", 40, { text: "later" });
    await connect("own", OWNER, false);
    expect(sentTexts()).toEqual([expect.stringContaining("Disconnected")]);
    expect(await keptIds("own")).toEqual([]);
    await incoming("own", 41, { text: "after" });
    expect(await keptIds("own")).toEqual([]);
  });

  it("deletes kept messages after the retention period", async () => {
    await sql`UPDATE business_messages SET sent_at = now() - interval '31 days' WHERE connection_id = 'early'`;
    expect(await clearExpiredBusinessMessages(sql, 30)).toBe(1);
    expect(await keptIds("early")).toEqual([]);
  });
});
