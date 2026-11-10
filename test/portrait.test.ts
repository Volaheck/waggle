import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createBot } from "../src/bot/bot.js";
import type { Config } from "../src/core/config.js";
import { createSql, migrate, type Sql } from "../src/core/db.js";
import { forgetUser } from "../src/core/users.js";
import {
  dueForWriting,
  observationsFrom,
  portraitMessages,
  portraitTick,
  readPrompt,
  type PortraitReadResult,
  type PortraitWriteResult,
} from "../src/worker/portrait.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const TZ = "Europe/Warsaw";
const OWNER = 9000;
const SUBJECT = { id: 8100, is_bot: false, first_name: "Kate" };
const FRIEND = { id: 7001, is_bot: false, first_name: "Anna" };
const STRANGER = { id: 8200, is_bot: false, first_name: "Eve" };
const GROUP = -100500;

const at = (iso: string) => new Date(iso);

describe("portrait prompts and answers", () => {
  const dm = [
    { chat_id: FRIEND.id, msg_id: 1, from_subject: false, speaker: "Anna", text: "Ты опять опоздала", sent_at: at("2026-11-09T10:00:00Z") },
    { chat_id: FRIEND.id, msg_id: 2, from_subject: true, speaker: "me", text: "Это не я, это автобус. Мой номер +48 600 123 456", sent_at: at("2026-11-09T10:01:00Z") },
  ];
  const group = {
    own: [{ chat_id: GROUP, chat_title: "Dev", msg_id: 50, from_subject: true, speaker: "me", text: "Нет, правильно говорить «в Украине»", sent_at: at("2026-11-09T12:00:00Z") }],
    around: [{ chat_id: GROUP, chat_title: "Dev", msg_id: 49, from_subject: false, speaker: "Bob", text: "на Украине всё дорого", sent_at: at("2026-11-09T11:59:00Z") }],
  };

  it("numbers only the person's own lines, keeps the rest as context and masks private data", () => {
    const { prompt, cited } = readPrompt({ now: at("2026-11-10T09:00:00Z"), timeZone: TZ, language: "Russian", known: [], dm, group });
    expect(prompt).toMatch(/== Chat with Anna ==\n\[2026-11-09 11:00\] Anna: Ты опять опоздала\n\[d1 2026-11-09 11:01\] me: Это не я/);
    expect(prompt).toMatch(/== Group «Dev» ==\n\[2026-11-09 12:59\] Bob: на Украине всё дорого\n\[g1 2026-11-09 13:00\] me: Нет, правильно/);
    expect(prompt).not.toContain("600 123 456");
    expect(prompt).toContain("<language>Russian</language>");
    expect([...cited.keys()]).toEqual(["d1", "g1"]);
  });

  it("keeps observations that cite real lines, and quotes only words that were really said", () => {
    const { cited } = readPrompt({ now: at("2026-11-10T09:00:00Z"), timeZone: TZ, language: "Russian", known: [], dm, group });
    const result: PortraitReadResult = {
      observations: [
        { area: "shadow", text: "Перекладывает вину на обстоятельства", quote: "Это не я, это автобус", strength: "weak", sources: ["d1"] },
        { area: "signals", text: "Поправляет формулировки других", quote: "выдуманная цитата", strength: "moderate", sources: ["g1", "d1", "g1"] },
        { area: "thinking", text: "Без источников", quote: null, strength: "strong", sources: ["d9"] },
        { area: "emotions", text: "  ", quote: null, strength: "weak", sources: ["d1"] },
      ],
    };
    const kept = observationsFrom(result, cited);
    expect(kept).toHaveLength(2);
    expect(kept[0]).toMatchObject({ area: "shadow", quote: "Это не я, это автобус", setting: "dm", sources: 1 });
    expect(kept[1]).toMatchObject({ area: "signals", quote: null, setting: "both", sources: 2 });
    expect(kept[1]!.seen_from.toISOString()).toBe("2026-11-09T10:01:00.000Z");
    expect(kept[1]!.seen_to.toISOString()).toBe("2026-11-09T12:00:00.000Z");
  });

  it("splits a long portrait into messages under Telegram's limit, with titles in the portrait's language", () => {
    const long = Array.from({ length: 12 }, (_, index) => `Абзац ${index} — ${"очень длинный текст о тебе ".repeat(30)}`).join("\n\n");
    const messages = portraitMessages({ core: "Ты человек, который <проверяет> всё дважды.", shadow: long, signals: "Признаков мало." }, "<i>footer</i>");
    expect(messages.length).toBeGreaterThan(2);
    for (const message of messages) expect(message.length).toBeLessThanOrEqual(3800);
    expect(messages[0]).toMatch(/^<b>🪞 Суть<\/b>\n\nТы человек, который &lt;проверяет&gt;/);
    expect(messages.join("\n")).toContain("<b>🌑 Теневая сторона</b>");
    expect(messages.at(-1)).toMatch(/<i>footer<\/i>$/);
  });

  it("writes the first portrait once there is enough, later ones every few days or on request", () => {
    const now = at("2026-11-10T09:00:00Z");
    const none = { sections: null, written_at: null, written_from: 0, rebuild_asked_at: null };
    expect(dueForWriting(none, 11, now)).toBe(false);
    expect(dueForWriting(none, 12, now)).toBe(true);
    const written = { sections: { core: "x" }, written_at: at("2026-11-08T09:00:00Z"), written_from: 20, rebuild_asked_at: null };
    expect(dueForWriting(written, 40, now)).toBe(false);
    expect(dueForWriting({ ...written, written_at: at("2026-11-06T09:00:00Z") }, 40, now)).toBe(true);
    expect(dueForWriting({ ...written, rebuild_asked_at: now }, 21, now)).toBe(true);
    expect(dueForWriting({ ...written, rebuild_asked_at: now }, 20, now)).toBe(false);
  });
});

describe.skipIf(!DATABASE_URL)("private portraits", () => {
  let sql: Sql;
  let bot: ReturnType<typeof createBot>["bot"];
  let updateId = 1;
  let readAnswer: PortraitReadResult = { observations: [] };
  const writeAnswer: PortraitWriteResult = {
    core: "Ты держишь дистанцию и проверяешь людей, прежде чем довериться.",
    thinking: "t",
    emotions: "e",
    relationships: "r",
    communication: "c",
    drives: "d",
    self_image: "s",
    shadow: "Ты перекладываешь вину на обстоятельства.",
    strengths: "st",
    signals: "Есть признаки, связанные с аутистическим спектром: буквальность и потребность в точности. Это не диагноз.",
    changes: null,
    limits: "l",
  };
  const prompts: { system: string; prompt: string; model: string }[] = [];
  const calls: { method: string; payload: Record<string, any> }[] = [];
  const config = {
    BOT_TOKEN: "123456:TEST-TOKEN", ADMIN_TG_IDS: [OWNER], DATABASE_URL: DATABASE_URL!, BOT_MODE: "polling", PORT: 0, EXTRACTION_MODEL: "x", EXTRACTION_INTERVAL_HOURS: 6,
    MESSAGE_RETENTION_DAYS: 7, DISPLAY_TIMEZONE: TZ, MONTHLY_LLM_BUDGET_USD: 60, CHAT_MONTHLY_BUDGET_USD: 20, WEB_DIST_DIR: "web/dist", DEV_BROWSER_LOGIN: false,
    DEV_LOGIN_AS: "", BUSINESS_MESSAGE_RETENTION_DAYS: 30, BUSINESS_REMINDER_MODEL: "claude-haiku-5-5", BUSINESS_REMINDERS_MONTHLY_BUDGET_USD: 2,
    PORTRAIT_READER_MODEL: "claude-sonnet-5-5", PORTRAIT_MODEL: "claude-opus-5-5", PORTRAIT_MONTHLY_BUDGET_USD: 20, PORTRAIT_PERSON_MONTHLY_USD: 3,
  } as unknown as Config;
  const anthropic = {
    messages: {
      stream(params: { model: string; system: string; messages: { content: string }[] }) {
        prompts.push({ system: params.system, prompt: params.messages[0]!.content, model: params.model });
        const answer = params.model === "claude-opus-5-5" ? writeAnswer : readAnswer;
        const message = { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(answer) }], usage: { input_tokens: 10_000, output_tokens: 1_000 } };
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
  const sentTo = (chatId: number) =>
    calls.filter((call) => (call.method === "sendMessage" || call.method === "editMessageText") && call.payload.chat_id === chatId).map((call) => String(call.payload.text));
  const deps = () => ({ sql, anthropic, api: bot.api, config, log: () => {} });
  const dmChat = { id: FRIEND.id, type: "private", first_name: "Anna" };
  const say = (from: { id: number; first_name: string }, messageId: number, text: string, connection = "kate") =>
    bot.handleUpdate({
      update_id: updateId++,
      business_message: { business_connection_id: connection, message_id: messageId, date: Math.floor(Date.now() / 1000) - 60, chat: dmChat, from, text },
    } as never);
  const command = (from: { id: number; first_name: string }, text: string) =>
    bot.handleUpdate({
      update_id: updateId++,
      message: { message_id: updateId, date: Math.floor(Date.now() / 1000), chat: { id: from.id, type: "private", first_name: from.first_name }, from, text, entities: [{ type: "bot_command", offset: 0, length: text.length }] },
    } as never);
  const tap = (from: { id: number; first_name: string }, data: string) =>
    bot.handleUpdate({
      update_id: updateId++,
      callback_query: { id: String(updateId), from, chat_instance: "ci", data, message: { message_id: 5, date: 0, chat: { id: from.id, type: "private", first_name: "x" }, text: "p" } },
    } as never);
  const lines = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM portrait_lines`)[0]!.n;

  beforeAll(async () => {
    sql = createSql(DATABASE_URL!);
    await sql`DROP SCHEMA public CASCADE`;
    await sql`CREATE SCHEMA public`;
    await migrate(sql);
    bot = createBot({ sql, config, anthropic }).bot;
    bot.botInfo = { id: 1, is_bot: true, first_name: "Waggle", username: "waggle_bot" } as typeof bot.botInfo;
    bot.api.config.use(fakeApi as never);
  });

  afterAll(async () => {
    await sql?.end();
  });

  beforeEach(() => {
    calls.length = 0;
    prompts.length = 0;
  });

  it("offers anyone who connects the bot a portrait, and keeps nothing until they start one", async () => {
    await bot.handleUpdate({ update_id: updateId++, business_connection: { id: "kate", user: SUBJECT, user_chat_id: SUBJECT.id, date: 0, is_enabled: true } } as never);
    expect(sentTo(SUBJECT.id)).toEqual([expect.stringContaining("/portrait")]);
    await say(FRIEND, 1, "Привет");
    expect(await lines()).toBe(0);

    calls.length = 0;
    await command(SUBJECT, "/portrait");
    const intro = calls.find((call) => call.method === "sendMessage")!;
    expect(intro.payload.text).toContain("Only you see it");
    expect(intro.payload.text).toContain("operator's server");
    expect(JSON.stringify(intro.payload.reply_markup)).toContain("bzp:start");
    await tap(SUBJECT, "bzp:start");
    expect((await sql`SELECT status FROM portraits WHERE tg_id = ${SUBJECT.id}`)[0]?.status).toBe("on");
  });

  it("reads both sides of their private chats and their group messages, then deletes the private lines", async () => {
    await say(FRIEND, 2, "Ты опять опоздала");
    await say(SUBJECT, 3, "Это не я, это автобус");
    // Deleted and edited messages stay an owners' feature.
    await bot.handleUpdate({ update_id: updateId++, deleted_business_messages: { business_connection_id: "kate", chat: dmChat, message_ids: [2] } } as never);
    expect(sentTo(SUBJECT.id)).toEqual([]);
    expect(await lines()).toBe(2);

    await sql`INSERT INTO chats (id, title, status) VALUES (${GROUP}, 'Dev', 'approved'), (-100600, 'Pending', 'pending')`;
    const [kate] = await sql<{ id: number }[]>`INSERT INTO users (tg_id, display_name) VALUES (${SUBJECT.id}, 'Kate') RETURNING id`;
    const [bob] = await sql<{ id: number }[]>`INSERT INTO users (tg_id, display_name) VALUES (7002, 'Bob') RETURNING id`;
    const [hidden] = await sql<{ id: number }[]>`INSERT INTO users (tg_id, display_name) VALUES (7003, 'Hidden') RETURNING id`;
    await sql`INSERT INTO members (chat_id, user_id, opted_out) VALUES (${GROUP}, ${kate!.id}, false), (${GROUP}, ${bob!.id}, false), (${GROUP}, ${hidden!.id}, true), (-100600, ${kate!.id}, false)`;
    await sql`
      INSERT INTO messages (chat_id, msg_id, user_id, sent_at, text) VALUES
        (${GROUP}, 48, ${hidden!.id}, now() - interval '3 hours', 'секрет того, кто отказался'),
        (${GROUP}, 49, ${bob!.id}, now() - interval '2 hours', 'на Украине всё дорого'),
        (${GROUP}, 50, ${kate!.id}, now() - interval '2 hours' + interval '1 minute', 'Нет, правильно говорить «в Украине»'),
        (-100600, 1, ${kate!.id}, now() - interval '1 hour', 'из неодобренного чата')`;

    readAnswer = { observations: [{ area: "shadow", text: "Перекладывает вину", quote: "Это не я, это автобус", strength: "weak", sources: ["d1"] }] };
    // Too little waits for more…
    await portraitTick(deps());
    expect(prompts).toEqual([]);
    // …unless it has waited long enough.
    await sql`UPDATE portrait_lines SET sent_at = sent_at - interval '2 days'`;
    await portraitTick(deps());
    expect(prompts).toHaveLength(1);
    const { prompt, model, system } = prompts[0]!;
    expect(model).toBe("claude-sonnet-5-5");
    expect(system).toContain("autism");
    expect(prompt).toMatch(/Anna: Ты опять опоздала\n\[d1 [^\]]+\] me: Это не я, это автобус/);
    expect(prompt).toMatch(/Bob: на Украине всё дорого\n\[g1 [^\]]+\] me: Нет, правильно говорить/);
    expect(prompt).not.toContain("секрет того, кто отказался");
    expect(prompt).not.toContain("из неодобренного чата");
    expect(await lines()).toBe(0);
    const [portrait] = await sql<{ read_dm: number; read_group: number }[]>`SELECT read_dm, read_group FROM portraits WHERE tg_id = ${SUBJECT.id}`;
    expect(portrait).toEqual({ read_dm: 1, read_group: 1 });
    expect((await sql`SELECT quote FROM portrait_observations`).map((row) => row.quote)).toEqual(["Это не я, это автобус"]);
    // Nothing is read twice.
    await portraitTick(deps());
    expect(prompts).toHaveLength(1);
  });

  it("writes the portrait once there is enough and shows it to that person only", async () => {
    await sql`
      INSERT INTO portrait_observations (tg_id, area, text, strength, setting, sources, seen_from, seen_to)
      SELECT ${SUBJECT.id}, 'thinking', 'наблюдение ' || n, 'moderate', 'dm', 2, now(), now() FROM generate_series(1, 12) n`;
    await portraitTick(deps());
    expect(prompts.map((call) => call.model)).toEqual(["claude-opus-5-5"]);
    expect(prompts[0]!.prompt).toContain("(none: this is the first portrait)");
    expect(prompts[0]!.prompt).toMatch(/\[o\d+ [^\]]+, dm, weak, 1 msg\] shadow: Перекладывает вину — «Это не я, это автобус»/);
    const sent = sentTo(SUBJECT.id).join("\n");
    expect(sent).toContain("<b>🪞 Суть</b>");
    expect(sent).toContain("аутистическим спектром");
    expect(sent).toContain("Only you see this");

    calls.length = 0;
    await command(STRANGER, "/portrait");
    expect(sentTo(STRANGER.id).join("\n")).not.toContain("Ты держишь дистанцию");
    expect(sentTo(STRANGER.id)[0]).toContain("A portrait of your character");
    await tap(STRANGER, "bzp:delete:yes");
    expect((await sql`SELECT count(*)::int AS n FROM portraits WHERE tg_id = ${SUBJECT.id}`)[0]!.n).toBe(1);

    calls.length = 0;
    await command(SUBJECT, "/portrait");
    expect(sentTo(SUBJECT.id).join("\n")).toContain("Ты держишь дистанцию");
    const [usage] = await sql<{ total: number }[]>`SELECT count(*)::int AS total FROM llm_usage WHERE purpose LIKE 'portrait_%'`;
    expect(usage!.total).toBe(2);
    expect(Number((await sql`SELECT spend_usd FROM portraits WHERE tg_id = ${SUBJECT.id}`)[0]!.spend_usd)).toBeGreaterThan(0);
  });

  it("stops at the person's monthly cap, but not for an owner", async () => {
    await sql`UPDATE portraits SET spend_usd = 3 WHERE tg_id = ${SUBJECT.id}`;
    await say(SUBJECT, 4, "ещё одно сообщение");
    await sql`UPDATE portrait_lines SET sent_at = sent_at - interval '2 days'`;
    await portraitTick(deps());
    expect(prompts).toEqual([]);
    expect(await lines()).toBe(1);
    await sql`UPDATE portraits SET spend_usd = 0 WHERE tg_id = ${SUBJECT.id}`;
  });

  it("pauses, and deletes everything on the person's own word or with /forgetme", async () => {
    await tap(SUBJECT, "bzp:pause");
    expect(await lines()).toBe(0);
    await say(SUBJECT, 5, "на паузе");
    expect(await lines()).toBe(0);
    await tap(SUBJECT, "bzp:start");
    await tap(SUBJECT, "bzp:delete");
    expect((await sql`SELECT count(*)::int AS n FROM portraits`)[0]!.n).toBe(1);
    await tap(SUBJECT, "bzp:delete:yes");
    expect((await sql`SELECT count(*)::int AS n FROM portraits`)[0]!.n).toBe(0);
    expect((await sql`SELECT count(*)::int AS n FROM portrait_observations`)[0]!.n).toBe(0);

    await tap(SUBJECT, "bzp:start");
    const [kate] = await sql<{ id: number }[]>`SELECT id FROM users WHERE tg_id = ${SUBJECT.id}`;
    await forgetUser(sql, kate!.id, { chatId: GROUP, messages: false });
    expect((await sql`SELECT count(*)::int AS n FROM portraits`)[0]!.n).toBe(1);
    await forgetUser(sql, kate!.id, { messages: false });
    expect((await sql`SELECT count(*)::int AS n FROM portraits`)[0]!.n).toBe(0);
  });
});
