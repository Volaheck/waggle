import type Anthropic from "@anthropic-ai/sdk";
import type { Message } from "grammy/types";
import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COMMAND_NAMES, createBot } from "../src/bot/bot.js";
import { commandLength } from "../src/bot/later.js";
import { dueLabel, LATER_CUE, PUT_OFF_CUE, REMINDER_SYSTEM_PROMPT, ReminderReadingSchema, reminderStandsIn, type ReminderReading } from "../src/bot/reminders.js";
import { READS_PER_HOUR, SELF_EDIT_SYSTEM_PROMPT, type SelfEditResult } from "../src/bot/self-edits.js";
import { migrateChat } from "../src/core/chat-migration.js";
import { registerChat, setChatStatus } from "../src/core/chats.js";
import type { Config } from "../src/core/config.js";
import { createSql, migrate, type Sql } from "../src/core/db.js";
import { executionMsgId, waitingReminders, type MemberReminder } from "../src/core/member-reminders.js";
import { saveBotMessage, saveMessage, updateEditedMessage } from "../src/core/messages.js";
import { copiedFrom } from "../src/core/own-card.js";
import { forgetUser, resolveUser, setOptOut, type User } from "../src/core/users.js";
import { isoDayIn } from "../src/core/zones.js";
import { deliverDueReminders } from "../src/worker/member-reminders.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const OWNER = 9900;
const WARSAW = "Europe/Warsaw";
const MENTION = "@waggle_test_bot";

/** A message as its reader sees it: HTML tags gone, entities read. */
const shown = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

describe("asking the bot to do something later", () => {
  it("is read on words that say when, in Russian and English, and never on a message without them", () => {
    const later = [
      "через 2 часа поставь мне статус «в отпуске»",
      "через полчаса проверь сборку",
      "через полтора часа",
      "через пару дней",
      "через месяц добавь заметку к проекту Atlas: проверить метрики",
      "через неделю закинь это в заметки",
      "завтра в 9 расскажи, что обсуждали ночью",
      "послезавтра",
      "сегодня вечером подведи итоги",
      "в пятницу в 18 подведи итоги недели",
      "в понедельник в 9 /top",
      "во вторник",
      "к 10 пришли сводку",
      "в 18:30 спроси меня",
      "20-го числа",
      "1 января",
      "на следующей неделе",
      "каждое утро в 9 подводи итоги",
      "in 2 hours set my tagline",
      "tomorrow at 9 sum up the night",
      "tonight",
      "next week",
      "on Friday",
      "at 9pm",
      "every day",
      // The ways chats say when, shortened or in words.
      "20 числа поставь мне статус «в отпуске»",
      "через 2ч поставь мне статус «занят»",
      "через 2 ч",
      "через 30м",
      "в восемь вечера",
      "к семи утра",
      "в два часа",
      "в полвосьмого",
      "8 вечера",
      "в эти выходные",
      "на этих выходных",
      "к вечеру",
      "в обед",
      "после обеда",
      "Friday 6pm",
      "Monday 9am",
      "in 2h",
      "in the morning",
    ];
    for (const text of later) expect(LATER_CUE.test(text), text).toBe(true);
    for (const text of [
      "запиши мне стек: Rust",
      "это в 2 раза быстрее",
      "в два раза быстрее",
      "выросло в 10% за месяц",
      "с днём рождения!",
      "как дела?",
      "who knows Rust?",
      "look at this",
      "render it in 3D",
      "Friday 13th again",
    ]) {
      expect(LATER_CUE.test(text), text).toBe(false);
    }
    // What waits for later can be listed or cancelled without a reminder word.
    for (const text of ["что у меня запланировано?", "отмени отложенное про статус", "cancel the scheduled one"]) expect(PUT_OFF_CUE.test(text), text).toBe(true);
  });

  it("takes something to do later only from words of the newest message that say when", () => {
    const read = (kind: ReminderReading["kind"], asks: string) => ({ kind, asks });
    expect(reminderStandsIn(read("later", "через 2 часа поставь мне статус"), "через 2 часа поставь мне статус «в отпуске»")).toBe(true);
    expect(reminderStandsIn(read("later", "поставь мне статус"), "через 2 часа поставь мне статус «в отпуске»")).toBe(false);
    expect(reminderStandsIn(read("later", "через 2 часа"), "через час поставь мне статус")).toBe(false);
    // An answer to the bot's question about what a request was missing asks for it by being one.
    expect(reminderStandsIn(read("later", "в субботу"), "в субботу", true)).toBe(true);
    expect(reminderStandsIn({ ...read("recurring", "каждое утро в 9 подводи итоги"), action: "подводи итоги" }, "каждое утро в 9 подводи итоги")).toBe(true);
    expect(reminderStandsIn(read("list", "что у меня запланировано"), "что у меня запланировано?")).toBe(true);
    expect(reminderStandsIn(read("list", "покажи отложенное"), "покажи отложенное")).toBe(true);
    // Without a reminder word, a list is of what is theirs, and something again and again names what to do.
    expect(reminderStandsIn(read("list", "что у нас запланировано на пятницу"), "что у нас запланировано на пятницу?")).toBe(false);
    expect(reminderStandsIn(read("recurring", "каждый день мне это говоришь"), "ты каждый день мне это говоришь")).toBe(false);
  });

  it("takes what to do as copied from their words: never another verb or object, never without its negation", () => {
    const when = (word: string) => ["через", "час", "в", "пятницу", "18"].includes(word);
    expect(copiedFrom("поставь мне статус «в отпуске»", "через 2 часа поставь мне статус «в отпуске»")).toBe(true);
    expect(copiedFrom("подведи итоги по каждому проекту", "подведи в пятницу в 18 итоги по каждому проекту", when)).toBe(true);
    expect(copiedFrom("подведи итоги по каждому проекту", "подведи в пятницу в 18 итоги по каждому проекту")).toBe(false);
    expect(copiedFrom("отмени напоминание про банк", "через час покажи напоминание про банк", when)).toBe(false);
    expect(copiedFrom("удали мои заметки про проект Atlas", "через час посмотри мои заметки про проект Atlas и скажи, какие устарели", when)).toBe(false);
    expect(copiedFrom("удали мои заметки про Atlas", "через час удали из заметок дубли, а мои заметки про Atlas сохрани", when)).toBe(false);
    expect(copiedFrom("ставь мне статус «занят»", "через час не ставь мне статус «занят»", when)).toBe(false);
    expect(copiedFrom("удалять мои заметки", "через час не надо удалять мои заметки", when)).toBe(false);
    expect(copiedFrom("не надо удалять мои заметки", "через час не надо удалять мои заметки", when)).toBe(true);
    expect(copiedFrom("delete my notes on the Atlas project", "in an hour show my notes on the Atlas project")).toBe(false);
  });

  it("reads what to do as a field of its own, and nothing that names a person, a chat or a row", () => {
    const when = { words: "через 2 часа", in: [{ amount: 2, unit: "hours" }], date: null, time: null, before: null };
    const reading = { kind: "later", asks: "через 2 часа поставь мне статус", also_asks: false, text: null, action: "поставь мне статус «в отпуске»", when, ref: null };
    expect(ReminderReadingSchema.safeParse(reading).success).toBe(true);
    expect(ReminderReadingSchema.safeParse({ ...reading, chat_id: -100 }).success).toBe(false);
    expect(ReminderReadingSchema.safeParse({ ...reading, when: { ...when, user_id: 7 } }).success).toBe(false);
  });

  it("knows a command of its own at the start of what to do, and every command it has a handler for", () => {
    const me = { username: "waggle_test_bot" };
    expect(commandLength("/top", me, COMMAND_NAMES)).toBe(4);
    expect(commandLength("/top@waggle_test_bot", me, COMMAND_NAMES)).toBe(20);
    expect(commandLength("/who @kit_k", me, COMMAND_NAMES)).toBe(4);
    expect(commandLength("/top@other_bot", me, COMMAND_NAMES)).toBeNull();
    expect(commandLength("/weather", me, COMMAND_NAMES)).toBeNull();
    expect(commandLength("/topics", me, COMMAND_NAMES)).toBeNull();
    expect(commandLength("покажи /top", me, COMMAND_NAMES)).toBeNull();
    const registered = readdirSync("src/bot")
      .filter((file) => file.endsWith(".ts"))
      .flatMap((file) => [...readFileSync(`src/bot/${file}`, "utf8").matchAll(/bot\.command\(\s*(\[[^\]]*\]|"[^"]+")/g)].flatMap((match) => [...match[1]!.matchAll(/"([^"]+)"/g)].map((name) => name[1]!)));
    expect(registered.length).toBeGreaterThan(20);
    for (const name of registered) expect(COMMAND_NAMES.has(name), name).toBe(true);
  });
});

describe.skipIf(!DATABASE_URL)("things members ask the bot to do later", () => {
  let sql: Sql;
  let nextChat = -1001000000900;
  let nextTgId = 8810;
  let nextMsgId = 90_000;
  /** The bot's own message ids, unique across the tests as in Telegram. */
  let nextBotMsgId = 900_000;
  let updateId = 1;
  const botInfo = { id: 4343, is_bot: true, first_name: "Waggle", username: "waggle_test_bot", can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false };
  const config = {
    BOT_TOKEN: "123456:TEST-TOKEN", ADMIN_TG_IDS: [OWNER], DATABASE_URL, BOT_MODE: "polling", PORT: 0, EXTRACTION_MODEL: "x", EXTRACTION_INTERVAL_HOURS: 6, EXTRACTION_PASS_MESSAGES: 200,
    EXTRACTION_MIN_GAP_MINUTES: 60, MESSAGE_RETENTION_DAYS: 7, DISPLAY_TIMEZONE: WARSAW, MONTHLY_LLM_BUDGET_USD: 60, CHAT_MONTHLY_BUDGET_USD: 20, WEB_DIST_DIR: "web/dist",
    DEV_BROWSER_LOGIN: false, DEV_LOGIN_AS: "", REPLY_MODEL: "claude-haiku-5-5", REPLIES_MONTHLY_BUDGET_USD: 10, REPLY_PREMIUM_MODEL: "claude-opus-5-5",
    REPLY_PREMIUM_PER_MEMBER_PER_HOUR: 10, REPLY_PREMIUM_MONTHLY_BUDGET_USD: 0, PLACE_ZONES_MODEL: "claude-haiku-5-5", INTERJECTIONS_PER_CHAT_PER_DAY: 0,
    INTERJECTION_MIN_GAP_HOURS: 3, BUSINESS_REMINDERS_MONTHLY_BUDGET_USD: 0, PORTRAIT_MONTHLY_BUDGET_USD: 0,
  } as unknown as Config;

  beforeAll(async () => {
    sql = createSql(DATABASE_URL!);
    await sql`DROP SCHEMA public CASCADE`;
    await sql`CREATE SCHEMA public`;
    await migrate(sql);
  });

  afterAll(async () => {
    await sql?.end();
  });

  type Later = Partial<ReminderReading> & Pick<ReminderReading, "kind">;
  type Card = Partial<SelfEditResult> & Pick<SelfEditResult, "kind">;
  const noWhen = { words: null, in: null, date: null, time: null, before: null };
  const later = (action: string, when: Partial<ReminderReading["when"]>, extra: Partial<ReminderReading> = {}): Later => ({ kind: "later", action, when: { ...noWhen, ...when }, ...extra });
  const hours = (amount: number) => ({ in: [{ amount, unit: "hours" as const }] });
  const inDays = (days: number) => isoDayIn(new Date(Date.now() + days * 86_400_000), WARSAW);

  /**
   * Claude as the bot uses it: the readings of reminders and things for later, the card requests' readings (each the
   * next one queued, else "nothing of the kind") and the answers, with every prompt kept.
   */
  function fakeClaude() {
    const readings: Later[] = [];
    const cards: Card[] = [];
    const prompts = { readings: [] as string[], cards: [] as string[], answers: [] as string[] };
    const newestOf = (prompt: string) => /<their_words>\n- (.*)\n/.exec(prompt)?.[1] ?? "";
    const structured = (payload: unknown) => {
      const message = { stop_reason: "end_turn", stop_details: null, content: [{ type: "text", text: JSON.stringify(payload) }], usage: { input_tokens: 600, output_tokens: 60 } };
      return { currentMessage: message, finalMessage: async () => message };
    };
    const client = {
      messages: {
        stream(params: { system: string; messages: { content: string }[] }) {
          const prompt = params.messages[0]!.content;
          if (params.system === REMINDER_SYSTEM_PROMPT) {
            prompts.readings.push(prompt);
            const reading = readings.shift() ?? { kind: "not_a_reminder" };
            return structured({ asks: reading.kind === "not_a_reminder" ? null : newestOf(prompt), also_asks: false, text: null, action: null, when: noWhen, ref: null, ...reading });
          }
          if (params.system === SELF_EDIT_SYSTEM_PROMPT) {
            prompts.cards.push(prompt);
            const card = cards.shift() ?? { kind: "not_a_request" };
            return structured({ asks: card.kind === "not_a_request" ? null : newestOf(prompt), also_asks: false, ops: [], ...card });
          }
          throw new Error("no such call is expected here");
        },
        create: async (params: { messages: { content: { text: string }[] }[] }) => {
          prompts.answers.push(params.messages[0]!.content.map((block) => block.text).join(""));
          return { stop_reason: "end_turn", content: [{ type: "text", text: "🐝 Ночью спорили о тестах." }], usage: { input_tokens: 1000, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
        },
      },
    } as unknown as Anthropic;
    return { client, readings, cards, prompts };
  }

  type Call = { method: string; payload: Record<string, any>; result?: Record<string, any>; error?: string };

  /**
   * Telegram as the bot sees it: who is in the chat (`status`: their status, or the whole member as Telegram gives it),
   * the forum topics closed since, and every call made.
   */
  function fakeTelegram() {
    const calls: Call[] = [];
    const names = new Map<number, string>();
    const telegram = { calls, names, closedTopics: new Set<number>(), status: (_tgId: number): string | Record<string, unknown> | Error => "member" };
    const transport = async (_prev: unknown, method: string, payload: Record<string, any>) => {
      const date = Math.floor(Date.now() / 1000);
      if (method === "getChatMember") {
        calls.push({ method, payload });
        const answer = telegram.status(payload.user_id);
        if (answer instanceof Error) throw answer;
        const member = typeof answer === "string" ? { status: answer } : answer;
        return { ok: true, result: { ...member, user: { id: payload.user_id, is_bot: false, first_name: names.get(payload.user_id) ?? "Someone" } } };
      }
      if (method === "sendMessage" && telegram.closedTopics.has(payload.message_thread_id)) {
        calls.push({ method, payload, error: "TOPIC_CLOSED" });
        return { ok: false, error_code: 400, description: "Bad Request: TOPIC_CLOSED" };
      }
      if (method === "sendMessage") {
        const chat = payload.chat_id < 0 ? { id: payload.chat_id, type: "supergroup", title: "Hive" } : { id: payload.chat_id, type: "private", first_name: "Someone" };
        const topic = payload.message_thread_id ? { is_topic_message: true, message_thread_id: payload.message_thread_id } : {};
        const result = { message_id: ++nextBotMsgId, date, chat, text: payload.text, ...topic };
        calls.push({ method, payload, result });
        return { ok: true, result };
      }
      calls.push({ method, payload });
      if (method === "editMessageText") return { ok: true, result: { message_id: payload.message_id, date, edit_date: date, chat: { id: payload.chat_id, type: "supergroup", title: "Hive" }, text: payload.text } };
      return { ok: true, result: true };
    };
    return { telegram, transport };
  }

  function harness(memberGapMs = 0, memberPerHour?: number) {
    const claude = fakeClaude();
    const { telegram, transport } = fakeTelegram();
    const answerLimits = { memberGapMs, ...(memberPerHour === undefined ? {} : { memberPerHour }) };
    const made = createBot({ sql, config, anthropic: claude.client, answerLimits, transport: transport as never });
    made.bot.botInfo = botInfo as typeof made.bot.botInfo;
    const idle = () => made.assistant!.idle();
    /** The worker's tick, with the bot's own hands for what is to be done. */
    const tick = () => deliverDueReminders({ sql, api: made.bot.api, botUsername: botInfo.username, config: { MESSAGE_RETENTION_DAYS: 7 }, perform: made.perform, log: () => {} });
    const deliver = async () => {
      const counts = await tick();
      await idle();
      return counts;
    };
    /** What the bot posted in a chat (or a private chat) since `from` calls were made. */
    const posted = (chatId: number, from = 0) => telegram.calls.slice(from).filter((call) => call.method === "sendMessage" && call.payload.chat_id === chatId);
    return { ...made, claude, telegram, idle, tick, deliver, posted };
  }
  type Harness = ReturnType<typeof harness>;

  type Member = User & { tg: { id: number; is_bot: false; first_name: string } };

  async function newChat(id?: number): Promise<number> {
    const chatId = id ?? (nextChat -= 1);
    await registerChat(sql, chatId, "Hive", null);
    await setChatStatus(sql, chatId, "approved", null);
    return chatId;
  }

  async function member(h: Harness, chatId: number, name: string): Promise<Member> {
    const tg = { id: ++nextTgId, is_bot: false as const, first_name: name };
    h.telegram.names.set(tg.id, name);
    return { ...(await resolveUser(sql, tg, [OWNER], chatId)), tg };
  }

  /** A chat the bot reads as Russian, so its own lines come in Russian. */
  async function russianChat(h: Harness, id?: number): Promise<number> {
    const chat = await newChat(id);
    const ann = await member(h, chat, "Ann");
    await saveMessage(sql, { chatId: chat, msgId: ++nextMsgId, userId: ann.id, sentAt: new Date(), text: "Сегодня выкатила новую версию своего проекта, работает заметно быстрее прежней", replyToMsgId: null, isForward: false, forwardSource: null, mediaType: null });
    return chat;
  }

  const groupMessage = (chatId: number, from: Member, text: string, extra: Partial<Message> = {}) =>
    ({ message_id: ++nextMsgId, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: "supergroup", title: "Hive" }, from: from.tg, text, ...extra }) as unknown as Message;

  /** A member writes in the chat, through the bot's own handlers. */
  async function write(h: Harness, chatId: number, from: Member, text: string, extra: Partial<Message> = {}): Promise<Message> {
    const message = groupMessage(chatId, from, text, extra);
    await h.bot.handleUpdate({ update_id: updateId++, message } as never);
    return message;
  }

  /** A member mentions the bot, and everything that starts settles. */
  async function ask(h: Harness, chatId: number, from: Member, text: string, extra: Partial<Message> = {}): Promise<Message> {
    const message = await write(h, chatId, from, `${MENTION} ${text}`, { entities: [{ type: "mention", offset: 0, length: MENTION.length }], ...extra } as Partial<Message>);
    await h.idle();
    return message;
  }

  /** A tap on a button under one of the bot's messages in the chat. */
  async function tap(h: Harness, chatId: number, from: Member, data: string, messageId: number): Promise<(string | undefined)[]> {
    const before = h.telegram.calls.length;
    const callback = { id: String(updateId), from: from.tg, chat_instance: "hive", data, message: { message_id: messageId, date: 0, chat: { id: chatId, type: "supergroup", title: "Hive" }, from: botInfo, text: "…" } };
    await h.bot.handleUpdate({ update_id: updateId++, callback_query: callback } as never);
    return h.telegram.calls.slice(before).filter((call) => call.method === "answerCallbackQuery").map((call) => call.payload.text as string | undefined);
  }

  const replyTo = (message: Message, from: unknown) => ({ reply_to_message: { ...message, from } }) as unknown as Partial<Message>;
  const rowsOf = (chatId: number) => sql<MemberReminder[]>`SELECT * FROM reminders WHERE chat_id = ${chatId} ORDER BY id`;
  const rowOf = async (id: number) => (await sql<MemberReminder[]>`SELECT * FROM reminders WHERE id = ${id}`)[0]!;
  const makeDue = (id: number) => sql`UPDATE reminders SET due_at = now() - interval '1 minute' WHERE id = ${id}`;
  const requestOf = async (chatId: number, msgId: number) =>
    (await sql<{ id: number; kind: string; status: string; receipt_msg_id: number | null; source_msg_id: number | null }[]>`
      SELECT id, kind, status, receipt_msg_id, source_msg_id FROM self_edits WHERE chat_id = ${chatId} AND msg_id = ${msgId}`)[0];
  const taglineOf = async (chatId: number, user: Pick<User, "id">) => (await sql<{ tagline: string | null }[]>`SELECT tagline FROM members WHERE chat_id = ${chatId} AND user_id = ${user.id}`)[0]!.tagline;

  it("puts off what a member asks for later, with a receipt the bot writes itself and a cancel button only they can use", async () => {
    const h = harness();
    const chat = await russianChat(h);
    const bob = await member(h, chat, "Bob");
    const kit = await member(h, chat, "Kit");
    h.claude.readings.push(later("поставь мне статус «в отпуске»", { words: "через 2 часа", ...hours(2) }));
    const asked = await ask(h, chat, bob, "через 2 часа поставь мне статус «в отпуске»");
    // One reading, for something to do later: the card is not read now, nor is anything answered.
    expect(h.claude.prompts.readings).toHaveLength(1);
    expect(h.claude.prompts.cards).toEqual([]);
    expect(h.claude.prompts.answers).toEqual([]);
    expect(await taglineOf(chat, bob)).toBeNull();
    const [action] = await rowsOf(chat);
    expect(action).toMatchObject({ kind: "action", user_id: bob.id, text: "поставь мне статус «в отпуске»", status: "pending", source_msg_id: asked.message_id, reply_to_msg_id: null, reply_text: null, time_zone: WARSAW, language: "Russian" });
    expect(Math.abs(action!.due_at.getTime() - (asked.date * 1000 + 2 * 3_600_000))).toBeLessThan(1_000);
    const [receipt] = h.posted(chat);
    expect(receipt!.payload.text).toBe(`⏳ Выполню ${dueLabel(action!.due_at, WARSAW, "Russian")} (по времени чата, Europe/Warsaw): «поставь мне статус «в отпуске»».`);
    expect(receipt!.payload.reply_parameters.message_id).toBe(asked.message_id);
    expect(receipt!.payload.reply_markup.inline_keyboard).toEqual([[{ text: "✖️ Отменить", callback_data: `rm:cancel:${action!.id}` }]]);
    expect(action!.receipt_msg_id).toBe(receipt!.result!.message_id);
    expect(await requestOf(chat, asked.message_id)).toMatchObject({ kind: "later", status: "applied", receipt_msg_id: receipt!.result!.message_id });

    // Its button is its asker's alone.
    expect(await tap(h, chat, kit, `rm:cancel:${action!.id}`, action!.receipt_msg_id!)).toEqual(["Это не твоя просьба"]);
    expect(await tap(h, chat, bob, `rm:cancel:${action!.id}`, action!.receipt_msg_id!)).toEqual(["Отменил"]);
    expect((await rowOf(action!.id)).status).toBe("cancelled");
    expect(h.telegram.calls.at(-1)).toMatchObject({ method: "editMessageText", payload: { text: `✖️ Отменил отложенное дело на ${dueLabel(action!.due_at, WARSAW, "Russian")}: «поставь мне статус «в отпуске»».` } });
  });

  it("answers a question about the future or the past now, and puts nothing off", async () => {
    const h = harness();
    const chat = await russianChat(h);
    const bob = await member(h, chat, "Bob");
    h.claude.readings.push({ kind: "not_a_reminder" });
    const asked = await ask(h, chat, bob, "кто завтра идёт на митап?");
    expect(h.claude.prompts.readings).toHaveLength(1);
    expect(h.claude.prompts.answers).toHaveLength(1);
    expect(h.claude.prompts.answers[0]).not.toContain("<asked_earlier");
    expect(await rowsOf(chat)).toEqual([]);
    expect(await requestOf(chat, asked.message_id)).toMatchObject({ kind: "not_a_request", status: "answered" });
  });

  it("keeps the limits: their own words of the newest message, a time ahead, 500 characters, 20 waiting of both kinds, none for someone who opted out", async () => {
    const h = harness();
    const chat = await russianChat(h);
    const bob = await member(h, chat, "Bob");
    const kit = await member(h, chat, "Kit");
    const refused = async (text: string, reading: Later, extra: Partial<Message> = {}) => {
      const before = h.telegram.calls.length;
      h.claude.readings.push(reading);
      await ask(h, chat, bob, text, extra);
      return h.posted(chat, before).map((call) => call.payload.text as string);
    };
    expect(await refused("через час поставь мне статус «занят»", later("купи мне яхту", hours(1)))).toEqual(["Ничего не отложил: этого нет в твоих словах"]);
    // Copied from their words: never another verb, nor without a negation, nor with the middle of what they asked left out.
    expect(await refused("через час покажи напоминание про банк", later("отмени напоминание про банк", hours(1)))).toEqual(["Ничего не отложил: этого нет в твоих словах"]);
    expect(await refused("через час не ставь мне статус «занят»", later("ставь мне статус «занят»", hours(1)))).toEqual(["Ничего не отложил: этого нет в твоих словах"]);
    expect(await refused("через час удали из заметок дубли, а мои заметки про Atlas сохрани", later("удали мои заметки про Atlas", hours(1)))).toEqual([
      "Ничего не отложил: этого нет в твоих словах",
    ]);
    // What to do is never drawn from the message a request replies to.
    const kits = await write(h, chat, kit, "поставь всем статус «в отпуске до понедельника»");
    expect(await refused("через час сделай это", later("поставь всем статус «в отпуске до понедельника»", hours(1)), replyTo(kits, kit.tg))).toEqual(["Ничего не отложил: этого нет в твоих словах"]);
    expect(await refused("вчера в 10 поставь мне статус «занят»", later("поставь мне статус «занят»", { words: "вчера в 10", date: inDays(-1), time: "10:00" }))).toEqual(["Ничего не отложил: это время уже прошло"]);
    const long = `напиши ${"очень ".repeat(90)}важное`;
    expect(await refused(`через час ${long}`, later(long, hours(1)))).toEqual(["Ничего не отложил: текст длиннее 500 знаков"]);
    expect(await rowsOf(chat)).toEqual([]);

    // Reminders and things to do later share one cap.
    for (let index = 0; index < 19; index += 1) {
      await sql`INSERT INTO reminders (chat_id, user_id, text, due_at, time_zone, source_msg_id) VALUES (${chat}, ${bob.id}, ${`дело ${index}`}, now() + interval '1 day', ${WARSAW}, ${index + 1})`;
    }
    await sql`INSERT INTO reminders (chat_id, user_id, kind, text, due_at, time_zone, source_msg_id) VALUES (${chat}, ${bob.id}, 'action', '/top', now() + interval '1 day', ${WARSAW}, 77)`;
    expect(await refused("через час поставь мне статус «занят»", later("поставь мне статус «занят»", hours(1)))).toEqual([
      "Ничего не отложил: у тебя здесь уже 20 напоминаний и отложенных дел, сначала отмени ненужные",
    ]);
    await setOptOut(sql, bob.id, true, chat);
    expect(await refused("через час поставь мне статус «занят»", later("поставь мне статус «занят»", hours(1)))).toEqual([
      "Ничего не отложил: ты просил ничего о тебе не хранить; включить обратно: /me → 🔒",
    ]);
    expect(await rowsOf(chat)).toEqual([]);
  });

  it("asks in the answer when a request for later is missing its time, and a reply to that answer completes it", async () => {
    const h = harness();
    const chat = await russianChat(h);
    const bob = await member(h, chat, "Bob");
    const own = await write(h, chat, bob, "уеду до среды");
    h.claude.readings.push(later("поставь мне статус «в отпуске»", { words: "на выходных" }));
    const vague = await ask(h, chat, bob, "на выходных поставь мне статус «в отпуске»", replyTo(own, bob.tg));
    expect(await rowsOf(chat)).toEqual([]);
    expect(await requestOf(chat, vague.message_id)).toMatchObject({ kind: "later_unclear", status: "answered" });
    expect(h.claude.prompts.answers).toHaveLength(1);
    expect(h.claude.prompts.answers[0]).toMatch(/<card_change[^>]*>nothing was scheduled for later yet: they asked the bot to do something for them later, but it could not tell when; .*do none of it now<\/card_change>/);
    const [question] = h.posted(chat);
    expect(question!.payload.reply_parameters.message_id).toBe(vague.message_id);

    // A reply to the answer, with no reminder word, is read with the request it completes.
    const saturday = inDays(3);
    h.claude.readings.push(later("поставь мне статус «в отпуске»", { words: "в субботу в 10", date: saturday, time: "10:00" }));
    const fromBot = { message_id: question!.result!.message_id, date: 0, chat: { id: chat, type: "supergroup", title: "Hive" }, from: botInfo, text: "Когда?" };
    const answer = await ask(h, chat, bob, "в субботу в 10", { reply_to_message: fromBot } as unknown as Partial<Message>);
    expect(h.claude.prompts.readings[1]).toContain("<you_asked_them>what their earlier request «на выходных поставь мне статус «в отпуске»» was missing: when, or what to do for them then</you_asked_them>");
    // It replies, when it is done, to what the request it completes replied to, not to the bot's question.
    const [action] = await rowsOf(chat);
    expect(action).toMatchObject({ kind: "action", text: "поставь мне статус «в отпуске»", source_msg_id: answer.message_id, reply_to_msg_id: own.message_id, reply_text: "уеду до среды", reply_author: "self" });
  });

  it("lists both kinds and cancels either, by its receipt, by words or by a button", async () => {
    const h = harness();
    const chat = await russianChat(h);
    const bob = await member(h, chat, "Bob");
    h.claude.readings.push({ kind: "remind", text: "позвонить в банк", when: { ...noWhen, in: [{ amount: 1, unit: "days" }] } });
    await ask(h, chat, bob, "напомни через день позвонить в банк");
    h.claude.readings.push(later("поставь мне статус «в отпуске»", hours(2)));
    await ask(h, chat, bob, "через 2 часа поставь мне статус «в отпуске»");
    h.claude.readings.push(later("/top", { in: [{ amount: 3, unit: "days" }] }));
    await ask(h, chat, bob, "через 3 дня /top");
    const [call, status, top] = await rowsOf(chat);

    h.claude.readings.push({ kind: "list" });
    const before = h.telegram.calls.length;
    await ask(h, chat, bob, "что у меня запланировано?");
    expect(h.claude.prompts.readings.at(-1)).toMatch(/r1 [^\n]*, to do: поставь мне статус «в отпуске»\nr2 [^\n]*, reminder: позвонить в банк\nr3 [^\n]*, to do: \/top\n/);
    const [list] = h.posted(chat, before);
    const label = (row: MemberReminder) => dueLabel(row.due_at, WARSAW, "Russian");
    expect(list!.payload.text.split("\n")).toEqual([
      "Твои напоминания и отложенные дела здесь (по времени чата, Europe/Warsaw):",
      `1. ⏳ ${label(status!)}: «поставь мне статус «в отпуске»»`,
      `2. ⏰ ${label(call!)}: «позвонить в банк»`,
      `3. ⏳ ${label(top!)}: «/top»`,
    ]);
    expect(list!.payload.reply_markup.inline_keyboard[0].map((button: { callback_data: string }) => button.callback_data)).toEqual([`rm:cancel:${status!.id}`, `rm:cancel:${call!.id}`, `rm:cancel:${top!.id}`]);

    // By words that name it, with no reminder word.
    h.claude.readings.push({ kind: "cancel", ref: "r1" });
    const named = h.telegram.calls.length;
    await ask(h, chat, bob, "отмени отложенное про статус");
    expect(h.posted(chat, named).map((sent) => sent.payload.text)).toEqual([`✖️ Отменил отложенное дело на ${label(status!)}: «поставь мне статус «в отпуске»».`]);
    expect((await rowOf(status!.id)).status).toBe("cancelled");

    // By a reply to its receipt with a word for cancelling, and nothing else.
    h.claude.readings.push({ kind: "cancel", ref: null });
    const receipt = { message_id: top!.receipt_msg_id, date: 0, chat: { id: chat, type: "supergroup", title: "Hive" }, from: botInfo, text: "⏳" };
    await ask(h, chat, bob, "отмени", { reply_to_message: receipt } as unknown as Partial<Message>);
    expect((await rowOf(top!.id)).status).toBe("cancelled");
    expect((await rowOf(call!.id)).status).toBe("pending");

    // By a button on the list, which then shows what is left.
    expect(await tap(h, chat, bob, `rm:cancel:${call!.id}`, list!.result!.message_id)).toEqual(["Отменил"]);
    expect((await rowOf(call!.id)).status).toBe("cancelled");
    // «What do you know about me» shows what is still to come, of both kinds.
    h.claude.readings.push(later("/top", { in: [{ amount: 3, unit: "days" }] }));
    await ask(h, chat, bob, "через 3 дня /top");
    expect((await waitingReminders(sql, chat, bob.id)).map((row) => [row.kind, row.text])).toEqual([["action", "/top"]]);
  });

  it("changes their card at its time as if they had just asked, its receipt replying to the request, with Undo", async () => {
    const h = harness();
    const chat = await russianChat(h);
    const bob = await member(h, chat, "Bob");
    h.claude.readings.push(later("поставь мне статус «в отпуске»", hours(2)));
    const asked = await ask(h, chat, bob, "через 2 часа поставь мне статус «в отпуске»");
    const [action] = await rowsOf(chat);
    await makeDue(action!.id);
    h.claude.cards.push({ kind: "edit", ops: [{ action: "set_tagline", field: null, ref: null, value: "в отпуске" }] });
    const before = h.telegram.calls.length;
    expect(await h.deliver()).toMatchObject({ sent: 1 });

    // It is read as a card request, the words that said when gone, and nothing reads it for later again.
    expect(h.claude.prompts.readings).toHaveLength(1);
    expect(h.claude.prompts.cards).toHaveLength(1);
    expect(h.claude.prompts.cards[0]).toContain("<their_words>\n- поставь мне статус «в отпуске»\n</their_words>");
    expect(h.claude.prompts.cards[0]).toContain("<asked_earlier>");
    expect(h.telegram.calls.slice(before).find((call) => call.method === "getChatMember")?.payload).toMatchObject({ chat_id: chat, user_id: bob.tg.id });
    expect(await taglineOf(chat, bob)).toBe("в отпуске");
    const [receipt] = h.posted(chat, before);
    expect(shown(receipt!.payload.text)).toBe("✏️ Твоя карточка:\nтеглайн: «в отпуске»");
    expect(receipt!.payload.reply_parameters.message_id).toBe(asked.message_id);
    // Done, its own receipt loses the cancel button.
    expect(await rowOf(action!.id)).toMatchObject({ status: "sent", attempts: 1 });
    expect(h.telegram.calls.slice(before).filter((call) => call.method === "editMessageReplyMarkup").map((call) => call.payload.message_id)).toEqual([action!.receipt_msg_id]);

    // On record apart from the request that asked for it, which it names as the change's source.
    const record = await requestOf(chat, executionMsgId(action!.id));
    expect(record).toMatchObject({ kind: "edit", status: "applied", source_msg_id: asked.message_id, receipt_msg_id: receipt!.result!.message_id });
    expect(await requestOf(chat, asked.message_id)).toMatchObject({ kind: "later", status: "applied" });
    const [logged] = await sql<{ source_msg_ids: number[] }[]>`SELECT source_msg_ids FROM change_log WHERE op = 'set_tagline' AND actor_user_id = ${bob.id} ORDER BY id DESC LIMIT 1`;
    expect(logged!.source_msg_ids).toEqual([asked.message_id]);
    expect(await tap(h, chat, bob, `se:undo:${record!.id}`, receipt!.result!.message_id)).toEqual(["↩️ Отменено."]);
    expect(await taglineOf(chat, bob)).toBeNull();
  });

  it("answers at its time with what was written since it was asked, replying to the request", async () => {
    const h = harness();
    const chat = await russianChat(h);
    const bob = await member(h, chat, "Bob");
    const kit = await member(h, chat, "Kit");
    h.claude.readings.push(later("расскажи, что обсуждали ночью", { words: "завтра в 9", date: inDays(1), time: "09:00" }));
    const asked = await ask(h, chat, bob, "завтра в 9 расскажи, что обсуждали ночью");
    await write(h, chat, kit, "Ночью выкатили новую сборку Atlas и до утра спорили о тестах");
    const [action] = await rowsOf(chat);
    await makeDue(action!.id);
    const before = h.telegram.calls.length;
    await h.deliver();
    expect(h.claude.prompts.cards).toEqual([]);
    expect(h.claude.prompts.answers).toHaveLength(1);
    const prompt = h.claude.prompts.answers[0]!;
    expect(prompt).toContain("Ночью выкатили новую сборку Atlas");
    expect(prompt).toMatch(/<asked_earlier note="[^"]+">they asked for it on \w{3} \d{1,2} \w{3} \d{4}, \d{2}:\d{2}, Europe\/Warsaw, to be done now: do it now as asked<\/asked_earlier>/);
    expect(prompt).toContain('<question from="Bob">\nрасскажи, что обсуждали ночью\n</question>');
    const [answer] = h.posted(chat, before);
    expect(answer!.payload.text).toBe("🐝 Ночью спорили о тестах.");
    expect(answer!.payload.reply_parameters.message_id).toBe(asked.message_id);
    // The answer is stored as a reply to a message of theirs, so their /forgetme blanks it with their messages.
    await forgetUser(sql, bob.id, { chatId: chat, messages: true });
    expect(await sql`SELECT text FROM messages WHERE chat_id = ${chat} AND msg_id = ${answer!.result!.message_id}`).toEqual([{ text: "" }]);
  });

  it("runs a command at its time through the bot's own handler, stores no message for it, and leaves the request as it was", async () => {
    const h = harness();
    const chat = await russianChat(h);
    const bob = await member(h, chat, "Bob");
    h.claude.readings.push(later("/top", { words: "в понедельник в 9", date: inDays(4), time: "09:00" }));
    const asked = await ask(h, chat, bob, "в понедельник в 9 /top");
    const [action] = await rowsOf(chat);
    await makeDue(action!.id);
    const before = h.telegram.calls.length;
    await h.deliver();
    const posted = h.posted(chat, before);
    expect(posted.map((call) => call.payload.text)).toEqual(["The catalog is empty for now. Add yours: /addproject link description"]);
    expect(posted[0]!.payload.reply_parameters.message_id).toBe(asked.message_id);
    expect(await sql`SELECT 1 FROM messages WHERE chat_id = ${chat} AND text = '/top'`).toEqual([]);
    expect(await requestOf(chat, executionMsgId(action!.id))).toMatchObject({ kind: "command", source_msg_id: asked.message_id });
    expect(h.claude.prompts.answers).toEqual([]);
    expect((await rowOf(action!.id)).status).toBe("sent");

    // /catchup reacts to the message it was given and writes privately: the request keeps no reaction of the bot's.
    await sql`UPDATE users SET dm_started = true WHERE id = ${bob.id}`;
    h.claude.readings.push(later("/catchup", hours(1)));
    await ask(h, chat, bob, "через час /catchup");
    const catchup = (await rowsOf(chat)).at(-1)!;
    await makeDue(catchup.id);
    const later2 = h.telegram.calls.length;
    await h.deliver();
    expect(h.telegram.calls.slice(later2).filter((call) => call.method === "setMessageReaction")).toEqual([]);
    expect(h.posted(bob.tg.id, later2)).toHaveLength(1);
  });

  it("does it once: a second try, or one a crash left half done, does nothing more", async () => {
    const h = harness();
    const chat = await russianChat(h);
    const bob = await member(h, chat, "Bob");
    h.claude.readings.push(later("поставь мне статус «в отпуске»", hours(2)));
    await ask(h, chat, bob, "через 2 часа поставь мне статус «в отпуске»");
    h.claude.readings.push(later("/top", hours(3)));
    await ask(h, chat, bob, "через 3 часа /top");
    const [status, top] = await rowsOf(chat);
    await makeDue(status!.id);
    await makeDue(top!.id);
    h.claude.cards.push({ kind: "edit", ops: [{ action: "set_tagline", field: null, ref: null, value: "в отпуске" }] });
    await h.deliver();
    const calls = h.telegram.calls.length;
    const cards = h.claude.prompts.cards.length;
    for (const row of [await rowOf(status!.id), await rowOf(top!.id)]) expect(await h.perform(row)).toBe("sent");
    await h.idle();
    expect(h.telegram.calls.length).toBe(calls);
    expect(h.claude.prompts.cards.length).toBe(cards);

    // A crash left both sending: taken again, they are finished without being done again.
    await sql`UPDATE reminders SET status = 'sending', claimed_at = now() - interval '11 minutes' WHERE id IN (${status!.id}, ${top!.id})`;
    await h.deliver();
    expect((await rowsOf(chat)).map((row) => row.status)).toEqual(["sent", "sent"]);
    expect(h.posted(chat, calls)).toEqual([]);
    expect(h.claude.prompts.cards.length).toBe(cards);
  });

  it("drops without a word what someone who has left, opted out or may not write asked for, and waits while Telegram can't be asked", async () => {
    const h = harness();
    const chat = await russianChat(h);
    const bob = await member(h, chat, "Bob");
    const kit = await member(h, chat, "Kit");
    const dora = await member(h, chat, "Dora");
    const max = await member(h, chat, "Max");
    for (const who of [bob, kit, dora, max]) {
      h.claude.readings.push(later("поставь мне статус «в отпуске»", hours(2)));
      await ask(h, chat, who, "через 2 часа поставь мне статус «в отпуске»");
    }
    const [bobs, kits, doras, maxs] = await rowsOf(chat);
    for (const row of [bobs, kits, doras, maxs]) await makeDue(row!.id);
    await sql`UPDATE members SET opted_out = true WHERE chat_id = ${chat} AND user_id = ${kit.id}`;
    // Max is still in the chat, muted by its admins.
    const muted = { status: "restricted", is_member: true, can_send_messages: false, until_date: 0 };
    h.telegram.status = (tgId) => (tgId === bob.tg.id ? "left" : tgId === dora.tg.id ? new Error("socket hang up") : tgId === max.tg.id ? muted : "member");
    const before = h.telegram.calls.length;
    expect(await h.deliver()).toMatchObject({ cancelled: 3, pending: 1 });
    expect(h.posted(chat, before)).toEqual([]);
    expect(h.claude.prompts.cards).toEqual([]);
    expect((await rowsOf(chat)).map((row) => row.status)).toEqual(["cancelled", "cancelled", "pending", "cancelled"]);
    expect((await sql<{ left_at: Date | null }[]>`SELECT left_at FROM members WHERE chat_id = ${chat} AND user_id = ${bob.id}`)[0]!.left_at).not.toBeNull();
    expect((await sql<{ left_at: Date | null }[]>`SELECT left_at FROM members WHERE chat_id = ${chat} AND user_id = ${max.id}`)[0]!.left_at).toBeNull();
    // Nobody is asked about someone who opted out.
    expect(h.telegram.calls.slice(before).filter((call) => call.method === "getChatMember").map((call) => call.payload.user_id)).toEqual([bob.tg.id, dora.tg.id, max.tg.id]);
  });

  it("never puts off again what it does now, and answers it on its own, apart from their questions of the moment", async () => {
    const h = harness(300);
    const chat = await russianChat(h);
    const bob = await member(h, chat, "Bob");
    h.claude.readings.push(later("напомни мне через час про созвон", { words: "завтра в 9", date: inDays(1), time: "09:00" }));
    await ask(h, chat, bob, "завтра в 9 напомни мне через час про созвон");
    const [action] = await rowsOf(chat);
    await ask(h, chat, bob, "как дела?");
    expect(h.claude.prompts.answers).toHaveLength(1);

    // A question waits out the gap after the last answer; meanwhile the action comes due, and its own «через час» has it
    // read as something for later once more.
    await write(h, chat, bob, `${MENTION} а у тебя?`, { entities: [{ type: "mention", offset: 0, length: MENTION.length }] } as Partial<Message>);
    await makeDue(action!.id);
    h.claude.readings.push(later("напомни мне про созвон", { words: "через час", ...hours(1) }));
    await h.deliver();
    expect(h.claude.prompts.readings).toHaveLength(2);
    expect(h.claude.prompts.readings[1]).toContain("<their_words>\n- напомни мне через час про созвон\n</their_words>");
    // It is done now: nothing new waits, and both the question and the action get their own answer.
    expect((await rowsOf(chat)).map((row) => [row.kind, row.status])).toEqual([["action", "sent"]]);
    expect(h.claude.prompts.answers).toHaveLength(3);
    expect(h.claude.prompts.answers.filter((prompt) => prompt.includes('<question from="Bob">\nа у тебя?'))).toHaveLength(1);
    const done = h.claude.prompts.answers.filter((prompt) => prompt.includes("<asked_earlier"));
    expect(done).toHaveLength(1);
    // The reminder it asks for was not set, and the answer is told so rather than left to claim one.
    expect(done[0]).toMatch(/<card_change[^>]*>no reminder was set: they asked for this earlier, to be done now, and the bot could not read it as a reminder with its time/);
  });

  it("sets at its time the reminder it was asked to set then, as if they had just asked", async () => {
    const h = harness();
    const chat = await russianChat(h);
    const bob = await member(h, chat, "Bob");
    h.claude.readings.push(later("напомни мне через час про созвон", { words: "завтра в 9", date: inDays(1), time: "09:00" }));
    const asked = await ask(h, chat, bob, "завтра в 9 напомни мне через час про созвон");
    const [action] = await rowsOf(chat);
    await makeDue(action!.id);
    h.claude.readings.push({ kind: "remind", text: "созвон", when: { ...noWhen, words: "через час", ...hours(1) } });
    const before = h.telegram.calls.length;
    await h.deliver();
    // The reading knows it is due now, so the hour in it is the reminder's own.
    expect(h.claude.prompts.readings[1]).toContain("<asked_earlier>they asked for this earlier, to be done now</asked_earlier>");
    const [, reminder] = await rowsOf(chat);
    expect(reminder).toMatchObject({ kind: "remind", text: "созвон", status: "pending", source_msg_id: asked.message_id, user_id: bob.id });
    expect(Math.abs(reminder!.due_at.getTime() - (Date.now() + 3_600_000))).toBeLessThan(60_000);
    const [receipt] = h.posted(chat, before);
    expect(receipt!.payload.text).toMatch(/^⏰ Напомню /);
    expect(receipt!.payload.reply_parameters.message_id).toBe(asked.message_id);
    expect(await requestOf(chat, executionMsgId(action!.id))).toMatchObject({ kind: "reminder", status: "applied", source_msg_id: asked.message_id });
  });

  it("brings back what the request replied to: its own or the bot's words as kept, another member's while the chat keeps them", async () => {
    const h = harness();
    const chat = await russianChat(h);
    const bob = await member(h, chat, "Bob");
    const kit = await member(h, chat, "Kit");
    const due = async (text: string, extra: Partial<Message>) => {
      h.claude.readings.push(later("закинь это в заметки", { in: [{ amount: 7, unit: "days" }] }));
      await ask(h, chat, bob, text, extra);
      return (await rowsOf(chat)).at(-1)!;
    };
    const own = await write(h, chat, bob, "релиз в пятницу; проверить метрики");
    const ownAction = await due("через неделю закинь это в заметки", replyTo(own, bob.tg));
    expect(ownAction).toMatchObject({ reply_to_msg_id: own.message_id, reply_text: "релиз в пятницу; проверить метрики", reply_author: "self" });
    const kits = await write(h, chat, kit, "созвон в четверг в 15:00");
    const kitsAction = await due("через неделю закинь это в заметки", replyTo(kits, kit.tg));
    expect(kitsAction).toMatchObject({ reply_to_msg_id: kits.message_id, reply_text: null, reply_author: null });
    const fromBot = ++nextBotMsgId;
    await saveBotMessage(sql, { chatId: chat, msgId: fromBot, sentAt: new Date(), text: "Итоги: выбрали Postgres", replyToMsgId: null });
    const botsAction = await due("через неделю закинь это в заметки", { reply_to_message: { message_id: fromBot, date: 0, chat: { id: chat, type: "supergroup", title: "Hive" }, from: botInfo, text: "Итоги: выбрали Postgres" } } as unknown as Partial<Message>);
    expect(botsAction).toMatchObject({ reply_text: "Итоги: выбрали Postgres", reply_author: "bot" });

    for (const row of [ownAction, kitsAction, botsAction]) await makeDue(row.id);
    await h.deliver();
    const [ownPrompt, kitsPrompt, botsPrompt] = h.claude.prompts.cards;
    expect(ownPrompt).toContain("<their_words>\n- закинь это в заметки\n- релиз в пятницу; проверить метрики\n</their_words>");
    expect(kitsPrompt).toContain('<they_reply_to from="another member">\nсозвон в четверг в 15:00\n</they_reply_to>');
    expect(botsPrompt).toContain('<they_reply_to from="you, the bot">\nИтоги: выбрали Postgres\n</they_reply_to>');

    // Another member's words gone from the chat (the retention, their /forgetme) are gone from it as well.
    const gone = await due("через неделю закинь это в заметки", replyTo(kits, kit.tg));
    await sql`UPDATE messages SET text = '' WHERE chat_id = ${chat} AND msg_id = ${kits.message_id}`;
    await makeDue(gone.id);
    await h.deliver();
    expect(h.claude.prompts.cards.at(-1)).not.toContain("<they_reply_to");
    expect(h.claude.prompts.cards.at(-1)).not.toContain("созвон");
  });

  it("keeps the bot's words only when they answer the asker, and never words their author changed after the request", async () => {
    const h = harness();
    const chat = await russianChat(h);
    const bob = await member(h, chat, "Bob");
    const kit = await member(h, chat, "Kit");
    const due = async (extra: Partial<Message>) => {
      h.claude.readings.push(later("закинь это в заметки", { in: [{ amount: 7, unit: "days" }] }));
      await ask(h, chat, bob, "через неделю закинь это в заметки", extra);
      return (await rowsOf(chat)).at(-1)!;
    };
    const fromBot = async (to: Message, text: string) => {
      const msgId = ++nextBotMsgId;
      await saveBotMessage(sql, { chatId: chat, msgId, sentAt: new Date(), text, replyToMsgId: to.message_id });
      return { reply_to_message: { message_id: msgId, date: 0, chat: { id: chat, type: "supergroup", title: "Hive" }, from: botInfo, text } } as unknown as Partial<Message>;
    };
    // The bot's answer to Kit is Kit's to erase: an action of Bob's that replies to it keeps no copy of it.
    const kitsQuestion = await write(h, chat, kit, "что у меня в карточке?");
    const toKit = await due(await fromBot(kitsQuestion, "Kit, у тебя в карточке Rust и Берлин"));
    expect(toKit).toMatchObject({ reply_text: null, reply_author: null });
    const bobsQuestion = await write(h, chat, bob, "что решили по базе?");
    const toBob = await due(await fromBot(bobsQuestion, "Выбрали Postgres"));
    expect(toBob).toMatchObject({ reply_text: "Выбрали Postgres", reply_author: "bot" });
    await forgetUser(sql, kit.id, { chatId: chat, messages: true });
    await makeDue(toKit.id);
    await makeDue(toBob.id);
    await h.deliver();
    const [kitsPrompt, bobsPrompt] = h.claude.prompts.cards;
    expect(kitsPrompt).not.toContain("<they_reply_to");
    expect(kitsPrompt).not.toContain("Берлин");
    expect(bobsPrompt).toContain('<they_reply_to from="you, the bot">\nВыбрали Postgres\n</they_reply_to>');

    // Words another member edited after the request are not the ones Bob asked about.
    const dora = await member(h, chat, "Dora");
    const doras = await write(h, chat, dora, "созвон в четверг в 15:00");
    const edited = await due(replyTo(doras, dora.tg));
    await updateEditedMessage(sql, chat, doras.message_id, "я обещаю всем пиво в пятницу", new Date(Date.now() + 5_000));
    await makeDue(edited.id);
    await h.deliver();
    expect(h.claude.prompts.cards.at(-1)).not.toContain("<they_reply_to");
    expect(h.claude.prompts.cards.at(-1)).not.toContain("пиво");
  });

  it("cancels at its time what it was to do later, by words or by a reply to its receipt, as when asked now", async () => {
    const h = harness();
    const chat = await russianChat(h);
    const bob = await member(h, chat, "Bob");
    h.claude.readings.push(later("поставь мне статус «в отпуске»", hours(5)));
    await ask(h, chat, bob, "через 5 часов поставь мне статус «в отпуске»");
    h.claude.readings.push(later("/top", hours(6)));
    await ask(h, chat, bob, "через 6 часов /top");
    const [status, top] = await rowsOf(chat);
    h.claude.readings.push(later("отмени отложенное про статус", hours(1)));
    await ask(h, chat, bob, "через час отмени отложенное про статус");
    h.claude.readings.push(later("отмени это", hours(1)));
    const receipt = { message_id: top!.receipt_msg_id, date: 0, chat: { id: chat, type: "supergroup", title: "Hive" }, from: botInfo, text: "⏳ Выполню: «/top»." };
    await ask(h, chat, bob, "через час отмени это", { reply_to_message: receipt } as unknown as Partial<Message>);
    const [, , byWords, byReply] = await rowsOf(chat);
    expect(byReply).toMatchObject({ text: "отмени это", reply_to_msg_id: top!.receipt_msg_id, reply_author: "bot" });

    await makeDue(byWords!.id);
    await makeDue(byReply!.id);
    h.claude.readings.push({ kind: "cancel", ref: "r1" }, { kind: "cancel", ref: null });
    const before = h.telegram.calls.length;
    await h.deliver();
    expect(h.claude.prompts.readings).toHaveLength(6);
    expect((await rowsOf(chat)).map((row) => row.status)).toEqual(["cancelled", "cancelled", "sent", "sent"]);
    const label = (row: MemberReminder) => dueLabel(row.due_at, WARSAW, "Russian");
    expect(h.posted(chat, before).map((call) => call.payload.text)).toEqual([
      `✖️ Отменил отложенное дело на ${label(status!)}: «поставь мне статус «в отпуске»».`,
      `✖️ Отменил отложенное дело на ${label(top!)}: «/top».`,
    ]);
    expect(h.posted(chat, before).map((call) => call.payload.reply_parameters.message_id)).toEqual([byWords!.source_msg_id, byReply!.source_msg_id]);
  });

  it("cancels by words that name what it was to do, its command among them, and reads a cancel word that names nothing as a question", async () => {
    const h = harness();
    const chat = await russianChat(h);
    const bob = await member(h, chat, "Bob");
    h.claude.readings.push(later("/top", hours(3)));
    await ask(h, chat, bob, "через 3 часа /top");
    h.claude.readings.push(later("поставь мне статус «в отпуске»", hours(2)));
    await ask(h, chat, bob, "через 2 часа поставь мне статус «в отпуске»");
    const [top, status] = await rowsOf(chat);
    h.claude.readings.push({ kind: "cancel", ref: "r2" });
    await ask(h, chat, bob, "отмени /top");
    expect(h.claude.prompts.readings).toHaveLength(3);
    expect([(await rowOf(top!.id)).status, (await rowOf(status!.id)).status]).toEqual(["cancelled", "pending"]);
    h.claude.readings.push({ kind: "cancel", ref: "r1" });
    await ask(h, chat, bob, "отмени статус «в отпуске»");
    expect((await rowOf(status!.id)).status).toBe("cancelled");
    await ask(h, chat, bob, "отмени уже этот спор");
    expect(h.claude.prompts.readings).toHaveLength(4);
    expect(h.claude.prompts.answers).toHaveLength(1);
  });

  it("posts outside the forum topic it was asked in once that topic is closed, still as its reply to the request", async () => {
    const h = harness();
    const chat = await russianChat(h);
    const bob = await member(h, chat, "Bob");
    const topic = { is_topic_message: true, message_thread_id: 77 } as Partial<Message>;
    h.claude.readings.push(later("поставь мне статус «в отпуске»", hours(2)));
    const asked = await ask(h, chat, bob, "через 2 часа поставь мне статус «в отпуске»", topic);
    h.claude.readings.push(later("/top", hours(3)));
    const askedTop = await ask(h, chat, bob, "через 3 часа /top", topic);
    const [status, top] = await rowsOf(chat);
    expect([status!.thread_id, top!.thread_id]).toEqual([77, 77]);
    h.telegram.closedTopics.add(77);
    await makeDue(status!.id);
    await makeDue(top!.id);
    h.claude.cards.push({ kind: "edit", ops: [{ action: "set_tagline", field: null, ref: null, value: "в отпуске" }] });
    const before = h.telegram.calls.length;
    await h.deliver();
    expect(await taglineOf(chat, bob)).toBe("в отпуске");
    const refused = h.posted(chat, before).filter((call) => call.error);
    expect(refused.map((call) => call.payload.message_thread_id)).toEqual([77, 77]);
    const posted = h.posted(chat, before).filter((call) => call.result);
    for (const call of posted) expect([call.payload.message_thread_id, call.payload.reply_parameters]).toEqual([undefined, undefined]);
    // Kept as the replies they are, so Bob's /forgetme blanks them with his messages.
    const kept = await sql<{ text: string; reply_to_msg_id: number | null }[]>`
      SELECT text, reply_to_msg_id FROM messages WHERE chat_id = ${chat} AND msg_id IN ${sql(posted.map((call) => call.result!.message_id))}`;
    expect(Object.fromEntries(kept.map((row) => [shown(row.text), row.reply_to_msg_id]))).toEqual({
      "✏️ Твоя карточка:\nтеглайн: «в отпуске»": asked.message_id,
      "The catalog is empty for now. Add yours: /addproject link description": askedTop.message_id,
    });
    expect((await rowsOf(chat)).map((row) => row.status)).toEqual(["sent", "sent"]);
  });

  it("puts off once what only names each of something, and refuses what asks for it again and again", async () => {
    const h = harness();
    const chat = await russianChat(h);
    const bob = await member(h, chat, "Bob");
    h.claude.readings.push(later("подведи итоги по каждому проекту", { words: "в пятницу в 18", date: inDays(3), time: "18:00" }));
    await ask(h, chat, bob, "подведи в пятницу в 18 итоги по каждому проекту");
    expect((await rowsOf(chat)).map((row) => [row.kind, row.text])).toEqual([["action", "подведи итоги по каждому проекту"]]);
    h.claude.readings.push(later("подводи итоги по каждому проекту", { words: "в 9", time: "09:00" }));
    const before = h.telegram.calls.length;
    await ask(h, chat, bob, "каждое утро в 9 подводи итоги по каждому проекту");
    expect(h.posted(chat, before).map((call) => call.payload.text)).toEqual(["🔁 Повторять по расписанию я не умею, выполняю только разовые просьбы: попроси сделать это один раз."]);
    expect(await rowsOf(chat)).toHaveLength(1);
  });

  it("tells the answer to ask again for a card change only when the rest of the message asks for one", async () => {
    const h = harness();
    const chat = await russianChat(h);
    const bob = await member(h, chat, "Bob");
    h.claude.readings.push(later("поставь мне статус «в отпуске»", hours(2), { also_asks: true }));
    await ask(h, chat, bob, "через 2 часа поставь мне статус «в отпуске», а кто сегодня дежурит?");
    expect(h.claude.prompts.answers[0]).toContain("the bot itself put off");
    expect(h.claude.prompts.answers[0]).not.toContain("did not read the rest of the message");
    h.claude.readings.push(later("поставь мне статус «занят»", hours(3), { also_asks: true }));
    await ask(h, chat, bob, "через 3 часа поставь мне статус «занят», а стек запиши: Rust");
    expect(h.claude.prompts.answers[1]).toContain("the bot did not read the rest of the message for a change to their card");
    expect(await rowsOf(chat)).toHaveLength(2);
  });

  it("goes unread past the hourly limit, and tells the answer of a message with only words that say when that it may ask nothing", async () => {
    // Answers of their own keep coming past the readings' limit.
    const h = harness(0, READS_PER_HOUR + 10);
    const chat = await russianChat(h);
    const bob = await member(h, chat, "Bob");
    // The member's readings for this hour used up.
    for (let read = 0; read < READS_PER_HOUR; read += 1) await ask(h, chat, bob, "а что вечером было?");
    const readings = h.claude.prompts.readings.length;
    const answers = h.claude.prompts.answers.length;
    await ask(h, chat, bob, "а что вечером было?");
    await ask(h, chat, bob, "через час поставь мне статус «занят»");
    expect(h.claude.prompts.readings).toHaveLength(readings);
    expect(h.claude.prompts.answers[answers]).toContain("if it asks nothing of the kind, answer it as usual and leave this out");
    expect(h.claude.prompts.answers[answers + 1]).toContain(`a request in it was not read, the bot reads at most ${READS_PER_HOUR} requests from one member an hour`);
  });

  it("goes with the rest of a member's data, and moves with a chat that becomes a supergroup", async () => {
    const h = harness();
    const group = await russianChat(h, -(6_000_000 + Math.floor(Math.random() * 1_000_000)));
    const bob = await member(h, group, "Bob");
    const kit = await member(h, group, "Kit");
    const kits = await write(h, group, kit, "созвон в четверг в 15:00");
    h.claude.readings.push(later("закинь это в заметки", { in: [{ amount: 7, unit: "days" }] }));
    const asked = await ask(h, group, bob, "через неделю закинь это в заметки", replyTo(kits, kit.tg));
    const supergroup = await newChat();
    await migrateChat(sql, group, supergroup);
    const [moved] = await rowsOf(supergroup);
    expect(moved).toMatchObject({ kind: "action", source_msg_id: asked.message_id - 2 ** 31, reply_to_msg_id: kits.message_id - 2 ** 31 });
    expect(await requestOf(supergroup, asked.message_id - 2 ** 31)).toMatchObject({ kind: "later" });

    // Opting out and /forgetme take actions along with reminders.
    h.claude.readings.push(later("/top", hours(1)));
    await ask(h, supergroup, bob, "через час /top");
    expect(await rowsOf(supergroup)).toHaveLength(2);
    await setOptOut(sql, bob.id, true, supergroup);
    expect(await rowsOf(supergroup)).toEqual([]);
    await setOptOut(sql, bob.id, false, supergroup);
    h.claude.readings.push(later("/top", hours(1)));
    await ask(h, supergroup, bob, "через час /top");
    expect(await rowsOf(supergroup)).toHaveLength(1);
    await forgetUser(sql, bob.id, { messages: false });
    expect(await rowsOf(supergroup)).toEqual([]);
  });
});
