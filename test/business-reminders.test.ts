import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createBot } from "../src/bot/bot.js";
import { chatsToRead, scheduleFor, zonedTime } from "../src/core/business-reminders.js";
import type { Config } from "../src/core/config.js";
import { createSql, migrate, type Sql } from "../src/core/db.js";
import { readChat, reminderLine, sendDueReminders, type RemindersResult } from "../src/worker/business-reminders.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const TZ = "Europe/Warsaw";
const OWNER = 9000;
const FRIEND = { id: 7001, is_bot: false, first_name: "Anna" };
const ME = { id: OWNER, is_bot: false, first_name: "Me" };

describe("reminder times", () => {
  it("turn a local date and time into the right instant, across daylight saving", () => {
    expect(zonedTime("2026-11-10", "19:00", TZ).toISOString()).toBe("2026-11-10T18:00:00.000Z");
    expect(zonedTime("2026-07-10", "19:00", TZ).toISOString()).toBe("2026-07-10T17:00:00.000Z");
    expect(zonedTime("2026-03-29", "12:00", TZ).toISOString()).toBe("2026-03-29T10:00:00.000Z");
  });

  it("remind of a plan two hours ahead, of the owner's promise that morning, of theirs when due", () => {
    const now = new Date("2026-11-09T21:00:00Z"); // 22:00 in Warsaw
    expect(scheduleFor({ kind: "plan", by: "both", date: "2026-11-12", time: "19:00" }, now, TZ)?.remindAt.toISOString()).toBe("2026-11-12T16:00:00.000Z");
    expect(scheduleFor({ kind: "promise", by: "me", date: "2026-11-10", time: null }, now, TZ)).toMatchObject({
      remindAt: new Date("2026-11-10T09:00:00Z"),
      dueHasTime: false,
    });
    expect(scheduleFor({ kind: "promise", by: "them", date: "2026-11-10", time: "15:00" }, now, TZ)?.remindAt.toISOString()).toBe("2026-11-10T14:00:00.000Z");
    expect(scheduleFor({ kind: "promise", by: "me", date: null, time: null }, now, TZ)?.remindAt.toISOString()).toBe("2026-11-10T09:00:00.000Z");
  });

  it("fall back to a later moment, and give up once every moment has passed", () => {
    const now = new Date("2026-11-10T17:00:00Z"); // 18:00 in Warsaw, the plan is at 19:00
    expect(scheduleFor({ kind: "plan", by: "both", date: "2026-11-10", time: "19:00" }, now, TZ)?.remindAt.toISOString()).toBe("2026-11-10T17:30:00.000Z");
    expect(scheduleFor({ kind: "plan", by: "both", date: "2026-11-10", time: null }, now, TZ)).toBeNull();
    expect(scheduleFor({ kind: "plan", by: "both", date: null, time: null }, now, TZ)).toBeNull();
  });

  it("phrase a reminder by who committed", () => {
    const base = { chat_name: "Anna <K>", what: "скинуть договор", due_at: null, due_has_time: false };
    expect(reminderLine({ ...base, kind: "promise", committed_by: "me" }, TZ)).toBe("You promised <b>Anna &lt;K&gt;</b>: скинуть договор");
    expect(reminderLine({ ...base, kind: "promise", committed_by: "them" }, TZ)).toBe("<b>Anna &lt;K&gt;</b> promised you: скинуть договор");
    expect(reminderLine({ ...base, kind: "plan", committed_by: "both", due_at: new Date("2026-11-12T18:00:00Z"), due_has_time: true }, TZ)).toBe(
      "Plan with <b>Anna &lt;K&gt;</b>: скинуть договор · 12 Nov, 19:00",
    );
  });
});

describe.skipIf(!DATABASE_URL)("reminders from owners' private chats", () => {
  let sql: Sql;
  let bot: ReturnType<typeof createBot>["bot"];
  let updateId = 1;
  let answer: RemindersResult = { items: [], resolved: [] };
  const prompts: string[] = [];
  const calls: { method: string; payload: Record<string, any> }[] = [];
  const config = {
    BOT_TOKEN: "123456:TEST-TOKEN", ADMIN_TG_IDS: [OWNER], DATABASE_URL: DATABASE_URL!, BOT_MODE: "polling", PORT: 0, EXTRACTION_MODEL: "x", EXTRACTION_INTERVAL_HOURS: 6,
    MESSAGE_RETENTION_DAYS: 7, DISPLAY_TIMEZONE: TZ, MONTHLY_LLM_BUDGET_USD: 60, CHAT_MONTHLY_BUDGET_USD: 20, WEB_DIST_DIR: "web/dist", DEV_BROWSER_LOGIN: false,
    DEV_LOGIN_AS: "", BUSINESS_MESSAGE_RETENTION_DAYS: 30, BUSINESS_REMINDER_MODEL: "claude-haiku-5-5", BUSINESS_REMINDERS_MONTHLY_BUDGET_USD: 2,
  } as unknown as Config;
  const anthropic = {
    messages: {
      stream(params: { messages: { content: string }[] }) {
        prompts.push(params.messages[0]!.content);
        const message = { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(answer) }], usage: { input_tokens: 2_000, output_tokens: 200 } };
        return { currentMessage: message, finalMessage: async () => message };
      },
    },
  } as unknown as Anthropic;
  const fakeApi = async (_prev: unknown, method: string, payload: Record<string, any>) => {
    calls.push({ method, payload });
    if (method === "sendMessage" || method === "editMessageText") {
      return { ok: true, result: { message_id: 1, date: 0, chat: { id: payload.chat_id ?? 0, type: "private", first_name: "x" }, text: payload.text } };
    }
    return { ok: true, result: true };
  };
  const chat = { id: FRIEND.id, type: "private", first_name: "Anna" };
  const say = (from: typeof FRIEND, messageId: number, text: string, minutesAgo = 30) =>
    bot.handleUpdate({
      update_id: updateId++,
      business_message: { business_connection_id: "own", message_id: messageId, date: Math.floor(Date.now() / 1000) - minutesAgo * 60, chat, from, text },
    } as never);
  const sent = () => calls.filter((call) => call.method === "sendMessage" || call.method === "editMessageText").map((call) => String(call.payload.text));
  const deps = () => ({ sql, anthropic, api: bot.api, config, log: () => {} });
  const reminders = () => sql<{ id: number; what: string; status: string; committed_by: string }[]>`SELECT id, what, status, committed_by FROM business_reminders ORDER BY id`;

  beforeAll(async () => {
    sql = createSql(DATABASE_URL!);
    await sql`DROP SCHEMA public CASCADE`;
    await sql`CREATE SCHEMA public`;
    await migrate(sql);
    bot = createBot({ sql, config, anthropic }).bot;
    bot.botInfo = { id: 1, is_bot: true, first_name: "Waggle", username: "waggle_bot" } as typeof bot.botInfo;
    bot.api.config.use(fakeApi as never);
    await bot.handleUpdate({
      update_id: updateId++,
      business_connection: { id: "own", user: ME, user_chat_id: OWNER, date: 0, is_enabled: true },
    } as never);
  });

  afterAll(async () => {
    await sql?.end();
  });

  beforeEach(() => {
    calls.length = 0;
    prompts.length = 0;
  });

  it("keeps both sides of the conversation and reads it once it is quiet", async () => {
    await say(ME, 1, "Завтра скину тебе договор, мой номер +48 600 123 456");
    await say(FRIEND, 2, "Отлично! И давай в четверг в 19:00 созвонимся");
    await say(ME, 3, "Ок", 5);
    expect(await chatsToRead(sql, 10, 60)).toEqual([]);
    await sql`UPDATE business_dialogue SET sent_at = sent_at - interval '10 minutes'`;
    const [ready] = await chatsToRead(sql, 10, 60);
    expect(ready).toMatchObject({ connection_id: "own", chat_id: FRIEND.id, owner_chat_id: OWNER });

    answer = {
      items: [
        { kind: "promise", by: "me", what: "скинуть договор", date: "2099-01-02", time: null, source: "m1" },
        { kind: "plan", by: "both", what: "созвон", date: "2099-01-05", time: "19:00", source: "m2" },
        { kind: "plan", by: "both", what: "in the past", date: "2000-01-01", time: "10:00", source: "m2" },
        { kind: "promise", by: "them", what: "", date: null, time: null, source: "m2" },
      ],
      resolved: [],
    };
    await readChat(deps(), ready!);
    expect(prompts[0]).toContain("<new_messages>");
    expect(prompts[0]).toMatch(/\] me: Завтра скину тебе договор/);
    expect(prompts[0]).toMatch(/\] Anna: Отлично!/);
    expect(prompts[0]).not.toContain("600 123 456");
    expect(prompts[0]).toMatch(/\(today\)/);
    expect((await reminders()).map((row) => [row.what, row.committed_by])).toEqual([
      ["скинуть договор", "me"],
      ["созвон", "both"],
    ]);
    expect(sent()).toEqual([expect.stringContaining("📝 Noted. You promised <b>Anna</b>: скинуть договор"), expect.stringContaining("📝 Noted. Plan with <b>Anna</b>: созвон")]);
    expect(await chatsToRead(sql, 0, 0)).toEqual([]);
    const [usage] = await sql<{ purpose: string }[]>`SELECT purpose FROM llm_usage`;
    expect(usage?.purpose).toBe("business_reminders");
  });

  it("sees what it already tracks and closes what the chat settled", async () => {
    const [promise] = await reminders();
    await say(ME, 4, "Скинул договор", 20);
    answer = { items: [], resolved: [`r${promise!.id}`, "r999999"] };
    const [ready] = await chatsToRead(sql, 10, 60);
    await readChat(deps(), ready!);
    expect(prompts[0]).toContain(`[r${promise!.id}] promise by me: скинуть договор`);
    expect(prompts[0]).toMatch(/<context>[\s\S]*Завтра скину/);
    expect((await reminders()).map((row) => row.status)).toEqual(["done", "open"]);
  });

  it("sends a reminder once it is due, and the buttons snooze and close it", async () => {
    const [, plan] = await reminders();
    await sql`UPDATE business_reminders SET remind_at = now() - interval '1 minute' WHERE id = ${plan!.id}`;
    expect(await sendDueReminders(deps())).toBe(1);
    expect(await sendDueReminders(deps())).toBe(0);
    const reminder = calls.find((call) => call.method === "sendMessage")!;
    expect(reminder.payload.text).toMatch(/^⏰ Plan with <b>Anna<\/b>: созвон/);
    expect(JSON.stringify(reminder.payload.reply_markup)).toContain(`bzr:done:${plan!.id}`);

    const tap = (from: typeof FRIEND, data: string) =>
      bot.handleUpdate({
        update_id: updateId++,
        callback_query: { id: String(updateId), from, chat_instance: "ci", data, message: { message_id: 5, date: 0, chat: { id: from.id, type: "private", first_name: "x" }, text: "r" } },
      } as never);
    await tap(FRIEND, `bzr:done:${plan!.id}`);
    expect((await reminders())[1]!.status).toBe("sent");
    await tap(ME, `bzr:hour:${plan!.id}`);
    const [snoozed] = await sql<{ status: string; remind_at: Date }[]>`SELECT status, remind_at FROM business_reminders WHERE id = ${plan!.id}`;
    expect(snoozed!.status).toBe("open");
    expect(snoozed!.remind_at.getTime()).toBeGreaterThan(Date.now() + 55 * 60 * 1000);

    calls.length = 0;
    await bot.handleUpdate({
      update_id: updateId++,
      message: { message_id: 6, date: Math.floor(Date.now() / 1000), chat: { id: OWNER, type: "private", first_name: "Me" }, from: ME, text: "/reminders", entities: [{ type: "bot_command", offset: 0, length: 10 }] },
    } as never);
    expect(sent()).toEqual([expect.stringMatching(/Plan with <b>Anna<\/b>: созвон[\s\S]*reminder /)]);

    await tap(ME, `bzr:done:${plan!.id}`);
    expect((await reminders())[1]!.status).toBe("done");
  });

  it("forgets the conversation and the reminders when the owner disconnects", async () => {
    await say(FRIEND, 7, "Пока");
    await bot.handleUpdate({ update_id: updateId++, business_connection: { id: "own", user: ME, user_chat_id: OWNER, date: 0, is_enabled: false } } as never);
    expect((await sql`SELECT count(*)::int AS n FROM business_dialogue`)[0]!.n).toBe(0);
    expect(await reminders()).toEqual([]);
  });
});
