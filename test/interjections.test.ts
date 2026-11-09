import type Anthropic from "@anthropic-ai/sdk";
import type { Message, UserFromGetMe } from "grammy/types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { answersInLastHour, replySystemPrompt } from "../src/bot/assistant.js";
import { createBot } from "../src/bot/bot.js";
import { INTERJECTION_SYSTEM_PROMPT, InterjectionSchema, liveSegments, type InterjectionResult, type SegmentRow } from "../src/bot/interjector.js";
import { buildReplyContext, type Question } from "../src/bot/reply-context.js";
import { migrateChat } from "../src/core/chat-migration.js";
import { getChat, registerChat, setChatStatus } from "../src/core/chats.js";
import type { Config } from "../src/core/config.js";
import { createSql, migrate, type Sql } from "../src/core/db.js";
import { callStructured } from "../src/core/llm.js";
import { clearExpiredTexts, saveBotMessage, saveMessage } from "../src/core/messages.js";
import { saveNote, type NoteInput } from "../src/core/notes.js";
import { addUserProject } from "../src/core/projects.js";
import { forgetUser, resolveUser, type User } from "../src/core/users.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const TOKEN = "123456:TEST-TOKEN";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const OWNER = 9700;
const SHIFT = 2 ** 31;

describe("the answer prompt", () => {
  const models = ["claude-haiku-5-5", "claude-opus-5-5"];

  it("explains every block of the context and how to use it, keeping the humour, the model split and the length", () => {
    for (const model of models) {
      const prompt = replySystemPrompt(model);
      for (const block of [
        "<about_you>", "<members>", "<who_is_who>", "<projects>", "<chronicle>", "<project_details>", "<in_focus>", "<running_jokes>", "<corrections>",
        "<thread>", "<your_message_they_reply_to>", "<recent_messages>", "<current_conversation>", "<your_recent_answers>", "<if_insulted>",
      ]) {
        expect(prompt, `${model} ${block}`).toContain(block);
      }
      for (const rule of [
        "🔒", "bouts with you", "bait", "claims and promises with their status and due date", "predictions with the date to check them", "broken promise",
        "one line per side and needle the weakest argument", "name a winner only when the facts settle it", "never repeat your own last joke",
        "A factual correction is not banter", "take it at once, without apologising", "never mention notes", "One precise, dated callback",
        "never invent facts", "at most about 80 words", "never explain or justify your tone", "never in stock motifs",
      ]) {
        expect(prompt, `${model}: ${rule}`).toContain(rule);
      }
    }
    expect(replySystemPrompt("claude-haiku-5-5")).not.toContain("draft three different angles");
    expect(replySystemPrompt("claude-opus-5-5")).toContain("draft three different angles");
  });
});

describe("speaking up uninvited, without a database", () => {
  const row = (msgId: number, userId: number | null, text: string, extra: Partial<SegmentRow> = {}): SegmentRow => ({
    msg_id: msgId, sent_at: new Date(), text, media_type: null, reply_to_bot: false, reply_to_msg_id: null, from_bot: false, user_id: userId,
    display_name: userId === null ? null : `P${userId}`, thread_id: null, is_forward: false, opted_out: false, ...extra,
  });
  const talk = (count: number, people = [1, 2], extra: (index: number) => Partial<SegmentRow> = () => ({})) =>
    Array.from({ length: count }, (_, index) => row(100 + index, people[index % people.length]!, `реплика ${index}`, extra(index)));

  it("finds a live conversation per forum topic: eight members' messages from two people, the bot's lines and forwards aside", () => {
    expect(liveSegments(talk(8))).toHaveLength(1);
    expect(liveSegments(talk(7))).toEqual([]);
    expect(liveSegments(talk(8, [1]))).toEqual([]);
    expect(liveSegments([...talk(7), row(200, null, "the bot again", { from_bot: true }), row(201, 1, "a post", { is_forward: true })])).toEqual([]);

    const [segment] = liveSegments([...talk(8), row(300, null, "an earlier line of the bot", { from_bot: true })]);
    expect(segment!.lines.map((line) => line.msg_id)).toContain(300);
    expect(segment!.usable.map((line) => line.msg_id)).not.toContain(300);

    const topics = liveSegments([...talk(8, [1, 2], () => ({ thread_id: 77 })), ...talk(3, [3, 4], () => ({ thread_id: 78 }))]);
    expect(topics.map((topic) => topic.threadId)).toEqual([77]);
  });

  it("drops the messages on a forbidden topic and keeps the rest, unless they are more than half", () => {
    const flagged = (index: number) => (index < 3 ? { text: `обсуждаем зарплату ${index}` } : {});
    const [segment] = liveSegments(talk(10, [1, 2], flagged));
    expect(segment!.usable).toHaveLength(7);
    expect(segment!.lines.some((line) => line.text.includes("зарплат"))).toBe(false);
    expect(liveSegments(talk(10, [1, 2], (index) => (index < 5 ? { text: "ипотека опять" } : {})))[0]!.usable).toHaveLength(5);
    expect(liveSegments(talk(10, [1, 2], (index) => (index < 6 ? { text: "ипотека опять" } : {})))).toEqual([]);
  });

  it("counts what someone who opted out wrote towards a live conversation, and never uses it", () => {
    const [segment] = liveSegments(talk(8, [1, 2, 3], (index) => (index % 3 === 2 ? { opted_out: true } : {})));
    expect(segment!.people.sort()).toEqual([1, 2]);
    expect(segment!.lines.every((line) => line.user_id !== 3)).toBe(true);
  });

  it("keeps the interjection prompt compact and silence the usual answer", () => {
    expect(INTERJECTION_SYSTEM_PROMPT.length).toBeLessThan(2000);
    for (const rule of ["Nobody called you", "speak=false", "silence is the usual answer", "who said what before, and when", "at most about 40 words", "never mention notes"]) {
      expect(INTERJECTION_SYSTEM_PROMPT).toContain(rule);
    }
    expect(Object.keys(InterjectionSchema.shape)).toEqual(["speak", "reply_to_msg_id", "text"]);
  });

  it("runs a structured call at low effort, the chronicler's, unless the caller asks for another", async () => {
    const efforts: unknown[] = [];
    const client = {
      messages: {
        stream(params: { output_config?: { effort?: string } }) {
          efforts.push(params.output_config?.effort);
          const message = { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ speak: false, reply_to_msg_id: null, text: "" }) }], usage: { input_tokens: 1, output_tokens: 1 } };
          return { currentMessage: message, finalMessage: async () => message };
        },
      },
    } as unknown as Anthropic;
    const request = { model: "claude-haiku-5-5", maxTokens: 100, system: "s", prompt: "p", schema: InterjectionSchema, onUsage: async () => {} };
    await callStructured(client, request);
    await callStructured(client, { ...request, effort: "medium" });
    expect(efforts).toEqual(["low", "medium"]);
  });
});

describe.skipIf(!DATABASE_URL)("speaking up uninvited", () => {
  let sql: Sql;
  let nextChat = -1001000000400;
  let nextMsgId = 90_000;
  let updateId = 1;
  const now = () => Math.floor(Date.now() / 1000);
  const me = { id: 4343, is_bot: true, first_name: "Waggle", username: "waggle_test_bot", can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false } as unknown as UserFromGetMe;
  const tg = (id: number, first_name: string, username: string) => ({ id, is_bot: false, first_name, username });
  const owner = tg(OWNER, "Maestro", "maestro_owner");
  const kit = tg(9701, "Kit", "kit_k");
  const bob = tg(9702, "Bob", "bob_b");
  const dora = tg(9703, "Dora", "dora_d");
  const eve = tg(9704, "Eve", "eve_e");
  const users: Record<string, User> = {};

  const calls: { method: string; payload: Record<string, any> }[] = [];
  /** Telegram as the bot sees it: a group's replies come back as supergroup messages, in the topic they were posted to. */
  const telegram = async (_prev: unknown, method: string, payload: Record<string, any>) => {
    calls.push({ method, payload });
    if (method === "getChatMember") return { ok: true, result: { status: "member", user: { id: payload.user_id, is_bot: false, first_name: "X" } } };
    if (method === "sendMessage" || method === "editMessageText") {
      const chat = payload.chat_id < 0 ? { id: payload.chat_id, type: "supergroup", title: "Hive" } : { id: payload.chat_id, type: "private", first_name: "X" };
      const text = payload.parse_mode === "HTML" ? String(payload.text).replace(/<[^>]*>/g, "") : String(payload.text);
      const topic = payload.message_thread_id ? { message_thread_id: payload.message_thread_id, is_topic_message: true } : {};
      return { ok: true, result: { message_id: method === "editMessageText" ? payload.message_id : ++nextMsgId, date: now(), chat, text, ...topic } };
    }
    return { ok: true, result: true };
  };
  const config = {
    BOT_TOKEN: TOKEN, ADMIN_TG_IDS: [OWNER], DATABASE_URL: DATABASE_URL!, BOT_MODE: "polling", PORT: 0, EXTRACTION_MODEL: "x", EXTRACTION_INTERVAL_HOURS: 6,
    MESSAGE_RETENTION_DAYS: 7, DISPLAY_TIMEZONE: "UTC", MONTHLY_LLM_BUDGET_USD: 60, CHAT_MONTHLY_BUDGET_USD: 20, WEB_DIST_DIR: "web/dist", DEV_BROWSER_LOGIN: false,
    DEV_LOGIN_AS: "", REPLY_MODEL: "claude-haiku-5-5", REPLIES_MONTHLY_BUDGET_USD: 10, REPLY_PREMIUM_MODEL: "claude-opus-5-5", REPLY_PREMIUM_PER_MEMBER_PER_HOUR: 10,
    REPLY_PREMIUM_MONTHLY_BUDGET_USD: 0, INTERJECTIONS_PER_CHAT_PER_DAY: 3, INTERJECTION_MIN_GAP_HOURS: 3,
  } as unknown as Config;

  /** Answers every question with one line and decides about speaking up as told (silence by default), `delayMs` after each request. */
  function fakeClaude(delayMs = 0) {
    const checks: { model: string; system: string; prompt: string; effort?: string; userId?: string }[] = [];
    const answers: { model: string; content: string }[] = [];
    let decide: (prompt: string) => InterjectionResult = () => ({ speak: false, reply_to_msg_id: null, text: "" });
    const usage = { input_tokens: 3000, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const client = {
      messages: {
        create: async (params: { model: string; messages: { content: string }[] }) => {
          answers.push({ model: params.model, content: params.messages[0]!.content });
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return { stop_reason: "end_turn", content: [{ type: "text", text: "Kit writes Rust 🐝" }], usage };
        },
        stream(params: { model: string; system: string; messages: { content: string }[]; output_config?: { effort?: string }; metadata?: { user_id?: string } }) {
          const prompt = params.messages[0]!.content;
          checks.push({ model: params.model, system: params.system, prompt, effort: params.output_config?.effort, userId: params.metadata?.user_id });
          const message = { stop_reason: "end_turn", stop_details: null, content: [{ type: "text", text: JSON.stringify(decide(prompt)) }], usage };
          return { currentMessage: message, finalMessage: () => new Promise((resolve) => setTimeout(() => resolve(message), delayMs)) };
        },
      },
    } as unknown as Anthropic;
    return { client, checks, answers, decideWith: (next: typeof decide) => void (decide = next) };
  }

  const made = (claude: ReturnType<typeof fakeClaude>, overrides: Partial<Config> = {}, limits: { chatPerHour?: number; memberPerHour?: number } = {}) => {
    const created = createBot({
      sql,
      config: { ...config, ...overrides } as Config,
      anthropic: claude.client,
      answerLimits: { memberGapMs: 0, ...limits },
      interjectionDebounceMs: 0,
      transport: telegram as never,
    });
    created.bot.botInfo = me as typeof created.bot.botInfo;
    return created;
  };

  beforeAll(async () => {
    sql = createSql(DATABASE_URL!);
    await sql`DROP SCHEMA public CASCADE`;
    await sql`CREATE SCHEMA public`;
    await migrate(sql);
  });

  afterAll(async () => {
    await sql?.end();
  });

  beforeEach(() => {
    calls.length = 0;
  });

  async function newChat(): Promise<number> {
    nextChat -= 1;
    await registerChat(sql, nextChat, "Hive", null);
    await setChatStatus(sql, nextChat, "approved", null);
    for (const person of [owner, kit, bob, dora, eve]) users[person.first_name] = await resolveUser(sql, person, [OWNER], nextChat);
    return nextChat;
  }

  async function say(chatId: number, user: User, text: string, options: { at?: Date; threadId?: number } = {}): Promise<number> {
    const msgId = ++nextMsgId;
    await saveMessage(sql, {
      chatId, msgId, userId: user.id, sentAt: options.at ?? new Date(), text, replyToMsgId: null, isForward: false, forwardSource: null, mediaType: null,
      threadId: options.threadId ?? null,
    });
    return msgId;
  }

  /** Debates the chronicle recorded among `people`, one for each title, that many days ago. */
  async function argument(chatId: number, people: User[], titles: [string, number][]): Promise<number[]> {
    const [run] = await sql<{ id: number }[]>`INSERT INTO extraction_runs (chat_id, status) VALUES (${chatId}, 'done') RETURNING id`;
    const ids: number[] = [];
    for (const [title, daysAgo] of titles) {
      const at = new Date(Date.now() - daysAgo * DAY);
      const [topic] = await sql<{ id: number }[]>`
        INSERT INTO chronicle (chat_id, run_id, period_from, period_to, title, summary, kind, user_ids, heat)
        VALUES (${chatId}, ${run!.id}, ${at}, ${at}, ${title}, 'Каждый остался при своём.', 'debate', ${people.map((person) => person.id)}, 10)
        RETURNING id`;
      ids.push(topic!.id);
    }
    return ids;
  }

  const FRONTEND: [string, number][] = [
    ["Claude против Codex для фронтенда", 40],
    ["Клод vs Кодекс: кто пишет фронтенд лучше", 20],
    ["Опус против GPT во фронтенде", 2],
  ];
  const TABS: [string, number][] = [
    ["Табы против пробелов в коде", 30],
    ["Снова табы или пробелы: код ревью", 12],
  ];
  const frontendTalk = (): [string, string][] => [
    ["Kit", "опять клод против жпт, и фронтенд на нём"],
    ["Bob", "жпт верстает фронтенд быстрее, проверено"],
    ["Kit", "быстрее не значит лучше"],
    ["Bob", "у тебя всё лучше, что от клода"],
    ["Kit", "опус вчера весь лендинг собрал"],
    ["Bob", "и сломал мобильную версию"],
    ["Kit", "это был кэш"],
    ["Bob", "конечно, кэш"],
  ];
  const tabsTalk = (): [string, string][] => [
    ["Dora", "табы или пробелы, опять отступы в коде"],
    ["Eve", "пробелы, конечно, в любом коде"],
    ["Dora", "табы экономят байты"],
    ["Eve", "байты, серьёзно?"],
    ["Dora", "и нервы"],
    ["Eve", "линтер всё решит"],
    ["Dora", "линтер на моей стороне"],
    ["Eve", "посмотрим"],
  ];

  /** The conversation of the last quarter of an hour, oldest first. */
  async function talk(chatId: number, lines: [string, string][], options: { threadId?: number } = {}): Promise<number[]> {
    const start = Date.now() - 15 * MINUTE;
    const ids: number[] = [];
    for (const [index, [name, text]] of lines.entries()) ids.push(await say(chatId, users[name]!, text, { at: new Date(start + index * MINUTE), threadId: options.threadId }));
    return ids;
  }

  /** One more message through the bot, as Telegram delivers it, and whatever the bot does about it. */
  async function write(created: ReturnType<typeof made>, chatId: number, from: ReturnType<typeof tg>, text: string, extra: Record<string, unknown> = {}) {
    await created.bot.handleUpdate({ update_id: updateId++, message: { message_id: ++nextMsgId, date: now(), chat: { id: chatId, type: "supergroup", title: "Hive" }, from, text, ...extra } } as never);
    await created.assistant?.idle();
    await created.interjector?.idle();
  }

  const checksIn = (chatId: number) =>
    sql<{ theme_key: string; spoke: boolean; msg_id: number | null; text: string | null }[]>`
      SELECT theme_key, spoke, msg_id, text FROM interjections WHERE chat_id = ${chatId} ORDER BY id`;
  const logged = (chatId: number, themeKey: string, spoke: boolean, ago: string) =>
    sql`INSERT INTO interjections (chat_id, theme_key, theme, spoke, created_at) VALUES (${chatId}, ${themeKey}, 'an earlier theme', ${spoke}, now() - ${ago}::interval)`;
  const stance = (chatId: number, input: Partial<NoteInput> & Pick<NoteInput, "userId" | "value">) =>
    saveNote(sql, { chatId, kind: "stance", about: null, status: null, dueAt: null, userIds: [], topicId: null, confidence: 0.9, sourceMsgIds: [], saidAt: new Date(Date.now() - 20 * DAY), replaces: null, ...input });
  const sentTo = (chatId: number) => calls.filter((call) => call.method === "sendMessage" && call.payload.chat_id === chatId);

  it("speaks once on a recurring argument, in its forum topic, with the argument's history, and then keeps quiet", async () => {
    const chat = await newChat();
    const topics = await argument(chat, [users.Kit!, users.Bob!], FRONTEND);
    await stance(chat, { userId: users.Kit!.id, value: "Claude пишет фронтенд чище", topicId: topics[0]!, about: FRONTEND[0]![0] });
    await stance(chat, { userId: users.Bob!.id, value: "Codex дешевле и быстрее", about: FRONTEND[1]![0], saidAt: new Date(Date.now() - 19 * DAY) });
    const ids = await talk(chat, frontendTalk(), { threadId: 77 });
    const claude = fakeClaude();
    const line = "Кит, Claude у тебя и в прошлый раз писал фронтенд чище. Кэш, видимо, тоже.";
    claude.decideWith(() => ({ speak: true, reply_to_msg_id: ids[6]!, text: line }));
    const created = made(claude, { REPLY_PREMIUM_MONTHLY_BUDGET_USD: 20 });

    await write(created, chat, kit, "ладно, кто прав-то", { is_topic_message: true, message_thread_id: 77 });
    expect(claude.checks).toHaveLength(1);
    const [check] = claude.checks;
    expect(check).toMatchObject({ model: "claude-opus-5-5", system: INTERJECTION_SYSTEM_PROMPT, effort: "medium" });
    expect(check!.userId).toMatch(/^[0-9a-f]{32}$/);
    expect(check!.prompt).toContain(`<theme kind="argument" times="3" title="Опус против GPT во фронтенде">`);
    expect(check!.prompt).toMatch(/- \d{1,2} \w{3,4}(?: \d{4})?: Claude против Codex для фронтенда — Каждый остался при своём\. \(Kit, Bob\)/);
    expect(check!.prompt).toMatch(/Sides:\n- Kit, \d{1,2} \w{3,4}(?: \d{4})?: “Claude пишет фронтенд чище”\n- Bob, \d{1,2} \w{3,4}(?: \d{4})?: “Codex дешевле и быстрее”/);
    expect(check!.prompt).toMatch(new RegExp(`\\[${ids[0]} [^\\]]+\\] Kit: опять клод против жпт`));
    expect(check!.prompt).toContain("Bob: конечно, кэш");
    expect(check!.prompt).toContain("Kit: ладно, кто прав-то");
    expect(check!.prompt).toContain("- Kit (@kit_k): Кит");
    expect(check!.prompt).toContain("Maestro (@maestro_owner)");
    expect(check!.prompt).not.toContain("Dora");

    const [sent] = sentTo(chat);
    expect(sent!.payload).toMatchObject({ text: line, message_thread_id: 77, reply_parameters: { message_id: ids[6] } });
    const [logRow] = await checksIn(chat);
    expect(logRow).toMatchObject({ theme_key: `t${topics[0]}`, spoke: true, text: line });
    const [stored] = await sql<{ from_bot: boolean; reply_to_msg_id: number; thread_id: number; text: string }[]>`
      SELECT from_bot, reply_to_msg_id, thread_id, text FROM messages WHERE chat_id = ${chat} AND msg_id = ${logRow!.msg_id}`;
    expect(stored).toEqual({ from_bot: true, reply_to_msg_id: ids[6], thread_id: 77, text: line });
    const usage = await sql<{ purpose: string; model: string }[]>`SELECT purpose, model FROM llm_usage WHERE chat_id = ${chat}`;
    expect(usage).toEqual([{ purpose: "reply_premium", model: "claude-opus-5-5" }]);

    // The argument goes on: the bot has had its say.
    await write(created, chat, bob, "ну и что тут скажешь", { is_topic_message: true, message_thread_id: 77 });
    await write(created, chat, kit, "опять клод против жпт", { is_topic_message: true, message_thread_id: 77 });
    expect(claude.checks).toHaveLength(1);
    expect(sentTo(chat)).toHaveLength(1);

    // The owner sees the day's interjections in /botstatus.
    const others = await sql<{ id: number }[]>`UPDATE chats SET status = 'left' WHERE id <> ${chat} AND status = 'approved' RETURNING id`;
    try {
      await created.bot.handleUpdate({ update_id: updateId++, message: { message_id: ++nextMsgId, date: now(), chat: { id: OWNER, type: "private", first_name: "Maestro" }, from: owner, text: "/botstatus", entities: [{ type: "bot_command", offset: 0, length: 10 }] } } as never);
      const status = String(sentTo(OWNER).at(-1)!.payload.text);
      expect(status).toContain("Speaking up uninvited: at most 3 times a chat a day, 3 h apart");
      expect(status).toContain("Interjections today: 1 check, 1 spoken");
    } finally {
      for (const { id } of others) await sql`UPDATE chats SET status = 'approved' WHERE id = ${id}`;
    }
  });

  it("keeps quiet when the model says so, records the check, and asks about a theme at most once an hour", async () => {
    const chat = await newChat();
    const [first] = await argument(chat, [users.Kit!, users.Bob!], FRONTEND);
    await talk(chat, frontendTalk());
    const claude = fakeClaude();
    const created = made(claude);

    await write(created, chat, kit, "так и запишем");
    expect(claude.checks).toHaveLength(1);
    expect(claude.checks[0]!.model).toBe("claude-haiku-5-5");
    expect(sentTo(chat)).toEqual([]);
    expect(await checksIn(chat)).toEqual([{ theme_key: `t${first}`, spoke: false, msg_id: null, text: null }]);
    expect(await sql`SELECT purpose FROM llm_usage WHERE chat_id = ${chat}`).toEqual([{ purpose: "reply" }]);

    await write(created, chat, bob, "так и запишем, ага");
    expect(claude.checks).toHaveLength(1);

    await sql`UPDATE interjections SET created_at = now() - interval '61 minutes' WHERE chat_id = ${chat}`;
    await write(created, chat, kit, "клод, жпт, фронтенд, всё по кругу");
    expect(claude.checks).toHaveLength(2);
  });

  it("keeps out for ten minutes after anything it said in the chat", async () => {
    const claude = fakeClaude();
    const created = made(claude);
    const chat = await newChat();
    await argument(chat, [users.Kit!, users.Bob!], FRONTEND);
    const ids = await talk(chat, frontendTalk());
    const answer = ++nextMsgId;
    await saveBotMessage(sql, { chatId: chat, msgId: answer, sentAt: new Date(Date.now() - 5 * MINUTE), text: "Kit writes Rust 🐝", replyToMsgId: ids[2]! });
    await write(created, chat, kit, "и всё же");
    expect(claude.checks).toHaveLength(0);
    await sql`UPDATE messages SET sent_at = now() - interval '11 minutes' WHERE chat_id = ${chat} AND msg_id = ${answer}`;
    await write(created, chat, bob, "и всё же, да");
    expect(claude.checks).toHaveLength(1);
  });

  it("never speaks twice when more messages come in while it decides", async () => {
    const claude = fakeClaude(100);
    claude.decideWith((prompt) => ({ speak: true, reply_to_msg_id: Number(/\[(\d+) [^\]]*\] Bob/.exec(prompt)![1]), text: "Третий раунд, тот же счёт." }));
    const created = made(claude);
    const chat = await newChat();
    await argument(chat, [users.Kit!, users.Bob!], FRONTEND);
    await talk(chat, frontendTalk());
    const update = (from: ReturnType<typeof tg>, text: string) => ({ update_id: updateId++, message: { message_id: ++nextMsgId, date: now(), chat: { id: chat, type: "supergroup", title: "Hive" }, from, text } });
    await created.bot.handleUpdate(update(kit, "клод") as never);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await created.bot.handleUpdate(update(bob, "жпт") as never);
    await created.bot.handleUpdate(update(kit, "фронтенд") as never);
    await created.interjector!.idle();
    expect(claude.checks).toHaveLength(1);
    expect(sentTo(chat)).toHaveLength(1);
  });

  it("does not speak up over an answer of its own that is under way", async () => {
    const claude = fakeClaude(150);
    const created = made(claude);
    const chat = await newChat();
    await argument(chat, [users.Kit!, users.Bob!], FRONTEND);
    await talk(chat, frontendTalk());
    const MENTION = "@waggle_test_bot";
    const update = (from: ReturnType<typeof tg>, text: string, extra: Record<string, unknown> = {}) => ({
      update_id: updateId++,
      message: { message_id: ++nextMsgId, date: now(), chat: { id: chat, type: "supergroup", title: "Hive" }, from, text, ...extra },
    });
    await created.bot.handleUpdate(update(kit, `${MENTION} кто прав?`, { entities: [{ type: "mention", offset: 0, length: MENTION.length }] }) as never);
    await created.bot.handleUpdate(update(bob, "клод против жпт, опять") as never);
    await created.interjector!.idle();
    await created.assistant!.idle();
    expect(claude.answers).toHaveLength(1);
    expect(claude.checks).toHaveLength(0);
  });

  it("waits the gap after speaking anywhere in the chat, and a day before the same theme", async () => {
    const claude = fakeClaude();
    const created = made(claude);

    const gapChat = await newChat();
    await argument(gapChat, [users.Dora!, users.Eve!], TABS);
    await talk(gapChat, tabsTalk());
    await logged(gapChat, "t1", true, "2 hours");
    await write(created, gapChat, dora, "табы, и точка");
    expect(claude.checks).toHaveLength(0);
    await sql`UPDATE interjections SET created_at = now() - interval '4 hours' WHERE chat_id = ${gapChat}`;
    await write(created, gapChat, eve, "пробелы, и точка");
    expect(claude.checks).toHaveLength(1);

    const dayChat = await newChat();
    const [first] = await argument(dayChat, [users.Kit!, users.Bob!], FRONTEND);
    await talk(dayChat, frontendTalk());
    await logged(dayChat, `t${first}`, true, "5 hours");
    await write(created, dayChat, kit, "опять двадцать пять");
    expect(claude.checks).toHaveLength(1);
    await sql`UPDATE interjections SET created_at = now() - interval '25 hours' WHERE chat_id = ${dayChat}`;
    await write(created, dayChat, bob, "опять двадцать пять, да");
    expect(claude.checks).toHaveLength(2);
    expect(claude.checks[1]!.prompt).toContain("Опус против GPT во фронтенде");
  });

  it("speaks no more than the daily cap", async () => {
    const claude = fakeClaude();
    const created = made(claude, { INTERJECTIONS_PER_CHAT_PER_DAY: 2, INTERJECTION_MIN_GAP_HOURS: 0 });
    const chat = await newChat();
    await argument(chat, [users.Kit!, users.Bob!], FRONTEND);
    await talk(chat, frontendTalk());
    await sql`INSERT INTO interjections (chat_id, theme_key, theme, spoke) VALUES (${chat}, 't1', 'one', true), (${chat}, 't2', 'two', true)`;
    await write(created, chat, kit, "и снова здравствуйте");
    expect(claude.checks).toHaveLength(0);
    await sql`DELETE FROM interjections WHERE chat_id = ${chat} AND theme_key = 't2'`;
    await write(created, chat, bob, "и снова, да");
    expect(claude.checks).toHaveLength(1);
  });

  it("stays quiet in a chat where an owner turned it off in /chats, and only an owner switches it", async () => {
    const claude = fakeClaude();
    const created = made(claude);
    const chat = await newChat();
    await argument(chat, [users.Kit!, users.Bob!], FRONTEND);
    await talk(chat, frontendTalk());
    const dm = (from: ReturnType<typeof tg>, text: string) => ({
      update_id: updateId++,
      message: { message_id: ++nextMsgId, date: now(), chat: { id: from.id, type: "private", first_name: from.first_name }, from, text, entities: [{ type: "bot_command", offset: 0, length: text.length }] },
    });
    const tap = (from: ReturnType<typeof tg>, data: string) => ({
      update_id: updateId++,
      callback_query: { id: `cq${updateId}`, from, chat_instance: "ci", data, message: { message_id: 1, date: now(), chat: { id: from.id, type: "private", first_name: from.first_name }, from: me, text: "chat" } },
    });
    const key = `c${Math.abs(chat)}`;

    await created.bot.handleUpdate(dm(owner, "/chats") as never);
    const entry = sentTo(OWNER).find((call) => String(call.payload.text).includes(`<code>${chat}</code>`))!;
    expect(String(entry.payload.text)).toContain("🗣 Speaks up uninvited: on");
    expect(JSON.stringify(entry.payload.reply_markup)).toContain(`interject:${key}:off`);

    await created.bot.handleUpdate(tap(kit, `interject:${key}:off`) as never);
    expect((await getChat(sql, chat))!.interjections).toBe(true);
    await created.bot.handleUpdate(tap(owner, `interject:${key}:off`) as never);
    expect((await getChat(sql, chat))!.interjections).toBe(false);
    const edited = calls.filter((call) => call.method === "editMessageText").at(-1)!;
    expect(String(edited.payload.text)).toContain("🤐 Speaks up uninvited: off");
    expect(JSON.stringify(edited.payload.reply_markup)).toContain(`interject:${key}:on`);

    await write(created, chat, kit, "клод против жпт, раунд сто");
    expect(claude.checks).toHaveLength(0);
    await created.bot.handleUpdate(tap(owner, `interject:${key}:on`) as never);
    await write(created, chat, bob, "раунд сто один");
    expect(claude.checks).toHaveLength(1);
  });

  it("leaves the messages on a forbidden topic out but still speaks when most of the conversation is clean", async () => {
    const claude = fakeClaude();
    claude.decideWith((prompt) => ({ speak: true, reply_to_msg_id: Number(/\[(\d+) [^\]]*\] Bob/.exec(prompt)![1]), text: "Третий раунд, тот же счёт." }));
    const created = made(claude);

    const clean = await newChat();
    await argument(clean, [users.Kit!, users.Bob!], FRONTEND);
    const talkWithMoney: [string, string][] = [...frontendTalk(), ["Kit", "а зарплата у фронтендеров какая?"], ["Bob", "ипотека сама себя не закроет"]];
    await talk(clean, talkWithMoney);
    await write(created, clean, kit, "налоги тоже");
    expect(claude.checks).toHaveLength(1);
    expect(claude.checks[0]!.prompt).not.toMatch(/зарплат|ипотек|налог/);
    expect(sentTo(clean)).toHaveLength(1);

    const mostlyMoney = await newChat();
    await argument(mostlyMoney, [users.Kit!, users.Bob!], FRONTEND);
    await talk(mostlyMoney, [
      ...frontendTalk().slice(0, 4),
      ["Kit", "зарплата фронтендера"], ["Bob", "зарплата бэкендера"], ["Kit", "ипотека"], ["Bob", "налоги"], ["Kit", "опять зарплата"],
    ]);
    await write(created, mostlyMoney, bob, "и ипотека, клод ли, жпт ли");
    expect(claude.checks).toHaveLength(1);
  });

  it("brings back a running joke with its twists and what it said about it before", async () => {
    const claude = fakeClaude();
    const created = made(claude);
    const chat = await newChat();
    const bit = (value: string, replaces: number | null, saidAt: Date) =>
      saveNote(sql, { chatId: chat, userId: null, kind: "bit", about: "чайник-оракул", value, status: null, dueAt: null, userIds: [users.Kit!.id, users.Bob!.id], topicId: null, confidence: 0.9, sourceMsgIds: [], saidAt, replaces });
    await bit("чайник-оракул предсказывает дождь", null, new Date(Date.now() - 20 * DAY));
    const [first] = await sql<{ id: number }[]>`SELECT id FROM notes WHERE chat_id = ${chat} AND kind = 'bit'`;
    await bit("чайник-оракул предсказывает падение прода по свисту", first!.id, new Date(Date.now() - 3 * DAY));
    await sql`
      INSERT INTO interjections (chat_id, theme_key, theme, spoke, text, created_at)
      VALUES (${chat}, ${`b${first!.id}`}, 'чайник-оракул', true, 'Оракул снова в деле.', now() - interval '2 days')`;
    await talk(chat, [
      ["Kit", "чайник опять свистит"], ["Bob", "оракул предсказывает падение прода"], ["Kit", "проверь логи"], ["Bob", "логи чистые"],
      ["Kit", "свист не врёт"], ["Bob", "чайник не врёт"], ["Kit", "значит, падение будет"], ["Bob", "ну жди"],
    ]);
    await write(created, chat, kit, "оракул сказал — прод упадёт");
    expect(claude.checks).toHaveLength(1);
    const theme = /<theme[^>]*>\n([\s\S]*?)\n<\/theme>/.exec(claude.checks[0]!.prompt)![0];
    expect(theme).toContain(`<theme kind="running joke" title="чайник-оракул">`);
    expect(theme).toMatch(/\n- \d{1,2} \w{3,4}(?: \d{4})?: “чайник-оракул предсказывает падение прода по свисту” \(Kit, Bob\)\n- \d{1,2} \w{3,4}(?: \d{4})?, an earlier twist: “чайник-оракул предсказывает дождь” \(Kit, Bob\)\n/);
    expect(theme).toMatch(/Your earlier lines on it:\n- \d{1,2} \w{3,4}(?: \d{4})?: “Оракул снова в деле\.”/);
  });

  it("leaves an argument alone when none of the people who keep having it are in the conversation", async () => {
    const claude = fakeClaude();
    const created = made(claude);
    const chat = await newChat();
    await argument(chat, [users.Dora!, users.Eve!], TABS);
    await talk(chat, tabsTalk().map(([name, text]): [string, string] => [name === "Dora" ? "Kit" : "Bob", text]));
    await write(created, chat, kit, "табы, конечно");
    expect(claude.checks).toHaveLength(0);
  });

  it("never brings up a theme that is itself on a forbidden topic", async () => {
    const claude = fakeClaude();
    const created = made(claude);
    const chat = await newChat();
    await argument(chat, [users.Kit!, users.Bob!], [["Ипотека против аренды: что выгоднее в долгую", 30], ["Аренда или ипотека: опять выгоднее в долгую", 10]]);
    await talk(chat, [
      ["Kit", "аренда выгоднее в долгую, считали же"], ["Bob", "в долгую выгоднее своё"], ["Kit", "ну-ну"], ["Bob", "аренда — деньги на ветер"],
      ["Kit", "посчитай"], ["Bob", "считал"], ["Kit", "плохо считал"], ["Bob", "выгоднее, говорю"],
    ]);
    await write(created, chat, kit, "аренда, аренда");
    expect(claude.checks).toHaveLength(0);
  });

  it("keeps the hourly limits and the stronger model's share across a restart, from the answers it posted", async () => {
    const claude = fakeClaude();
    const settings = { REPLY_PREMIUM_MONTHLY_BUDGET_USD: 20, REPLY_PREMIUM_PER_MEMBER_PER_HOUR: 1, INTERJECTIONS_PER_CHAT_PER_DAY: 0 };
    const limits = { memberPerHour: 3, chatPerHour: 4 };
    const chat = await newChat();
    const MENTION = "@waggle_test_bot";
    const ask = (created: ReturnType<typeof made>, from: ReturnType<typeof tg>, question: string) =>
      write(created, chat, from, `${MENTION} ${question}`, { entities: [{ type: "mention", offset: 0, length: MENTION.length }] });

    const before = made(claude, settings, limits);
    expect(before.interjector).toBeUndefined();
    await ask(before, kit, "who writes Rust?");
    await ask(before, kit, "and Go?");
    expect(claude.answers.map((answer) => answer.model)).toEqual(["claude-opus-5-5", "claude-haiku-5-5"]);

    // A new process knows only what the database keeps, and a question that comes in before it has read them waits.
    const lock = await sql.reserve();
    await lock`BEGIN`;
    await lock`LOCK TABLE interjections IN ACCESS EXCLUSIVE MODE`;
    const after = made(claude, settings, limits);
    const early = ask(after, kit, "and Zig?");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(claude.answers).toHaveLength(2);
    await lock`COMMIT`;
    lock.release();
    await early;
    await ask(after, kit, "and Odin?");
    await ask(after, bob, "and what about projects?");
    await ask(after, dora, "and the chronicle?");
    expect(claude.answers.map((answer) => answer.model)).toEqual(["claude-opus-5-5", "claude-haiku-5-5", "claude-haiku-5-5", "claude-opus-5-5"]);
    const notes = sentTo(chat).map((call) => String(call.payload.text));
    expect(notes.filter((text) => text.includes("plenty of questions from you"))).toHaveLength(1);
    expect(notes.filter((text) => text.includes("answered a lot here this hour"))).toHaveLength(1);
  });

  it("counts as answers neither its short notes nor its interjections, nor anything older than an hour", async () => {
    const chat = await newChat();
    const asked = await say(chat, users.Kit!, "@waggle_test_bot hi");
    const answer = async (text: string, at = new Date()) => {
      const msgId = ++nextMsgId;
      await saveBotMessage(sql, { chatId: chat, msgId, sentAt: at, text, replyToMsgId: asked });
      return msgId;
    };
    await answer("Kit writes Rust 🐝");
    await answer("an answer from yesterday", new Date(Date.now() - DAY));
    await answer("🐝 I'll pass on this one.");
    await answer("🐝 С тебя на этот час вопросов хватит, улью нужна передышка.");
    const interjection = await answer("Третий раунд, тот же счёт.");
    await sql`INSERT INTO interjections (chat_id, theme_key, theme, msg_id, spoke, text) VALUES (${chat}, 't1', 'theme', ${interjection}, true, 'Третий раунд, тот же счёт.')`;
    const counted = (await answersInLastHour(sql)).filter((row) => row.chat_id === chat);
    expect(counted.map((row) => row.tg_id)).toEqual([kit.id]);
  });

  it("carries its log over a supergroup upgrade, and lets an interjection's words go with the message texts", async () => {
    const group = -5_000_000_401;
    await registerChat(sql, group, "Old hive", null);
    await setChatStatus(sql, group, "approved", null);
    const kitUser = await resolveUser(sql, kit, [OWNER], group);
    const asked = await say(group, kitUser, "клод против жпт", { at: new Date(Date.now() - 9 * DAY) });
    await sql`UPDATE messages SET extracted_at = now() WHERE chat_id = ${group}`;
    await saveBotMessage(sql, { chatId: group, msgId: asked + 1, sentAt: new Date(Date.now() - 9 * DAY), text: "Третий раунд.", replyToMsgId: asked });
    nextMsgId += 1;
    await sql`INSERT INTO interjections (chat_id, theme_key, theme, msg_id, spoke, text, created_at) VALUES (${group}, 't1', 'theme', ${asked + 1}, true, 'Третий раунд.', now() - interval '9 days')`;
    const upgraded = -1_001_000_000_499;
    await migrateChat(sql, group, upgraded);
    expect(await sql`SELECT chat_id, msg_id FROM interjections WHERE theme_key = 't1' AND chat_id IN (${group}, ${upgraded})`).toEqual([{ chat_id: upgraded, msg_id: asked + 1 - SHIFT }]);
    expect(await sql`SELECT thread_id FROM messages WHERE chat_id = ${upgraded} AND msg_id = ${asked - SHIFT}`).toEqual([{ thread_id: null }]);

    await clearExpiredTexts(sql, 7);
    expect(await sql`SELECT text FROM interjections WHERE chat_id = ${upgraded}`).toEqual([{ text: null }]);

    const chat = await newChat();
    const recent = await say(chat, users.Kit!, "клод против жпт");
    await saveBotMessage(sql, { chatId: chat, msgId: recent + 1, sentAt: new Date(), text: "Опять?", replyToMsgId: recent });
    nextMsgId += 1;
    await sql`INSERT INTO interjections (chat_id, theme_key, theme, msg_id, spoke, text) VALUES (${chat}, 't1', 'theme', ${recent + 1}, true, 'Опять?')`;
    await clearExpiredTexts(sql, 7);
    expect(await sql`SELECT text FROM interjections WHERE chat_id = ${chat}`).toEqual([{ text: "Опять?" }]);
    await forgetUser(sql, users.Kit!.id, { chatId: chat, messages: true });
    expect(await sql`SELECT text FROM interjections WHERE chat_id = ${chat}`).toEqual([{ text: null }]);
    expect(await sql`SELECT text FROM messages WHERE chat_id = ${chat} AND msg_id = ${recent + 1}`).toEqual([{ text: "" }]);
  });

  it("explains in the answer prompt every block an answer's context holds", async () => {
    const chat = await newChat();
    await addUserProject(sql, { chatId: chat, name: "Atlas", actorUserId: users.Kit!.id });
    await saveNote(sql, { chatId: chat, userId: null, kind: "bit", about: "чайник-оракул", value: "чайник-оракул предсказывает релизы", status: null, dueAt: null, userIds: [users.Kit!.id, users.Bob!.id], topicId: null, confidence: 0.9, sourceMsgIds: [], saidAt: new Date(), replaces: null });
    await saveNote(sql, { chatId: chat, userId: null, kind: "correction", about: null, value: "релиз Atlas — в пятницу, не в среду", status: null, dueAt: null, userIds: [], topicId: null, confidence: 0.9, sourceMsgIds: [], saidAt: new Date(), replaces: null });
    const parent = await say(chat, users.Bob!, "Atlas — мой проект, и рейтинг у него ниже, чем надо");
    const from = { id: kit.id, is_bot: false, first_name: "Kit", username: "kit_k" };
    const question: Question = {
      chatId: chat,
      chatTitle: "Hive",
      from,
      me,
      message: {
        message_id: ++nextMsgId, date: now(), chat: { id: chat, type: "supergroup", title: "Hive" }, from, text: "рассуди, кто прав про рейтинг Atlas?",
        reply_to_message: { message_id: parent, date: now(), chat: { id: chat, type: "supergroup", title: "Hive" }, from: { id: bob.id, is_bot: false, first_name: "Bob" }, text: "Atlas — мой проект" },
      } as unknown as Message,
    };
    const context = await buildReplyContext(sql, question, { timezone: "UTC", model: "claude-opus-5-5", ownerTgIds: [OWNER], recentAnswers: [{ to: "Gleb", text: "an answer of an hour ago" }], insultMotif: "the scrolls are sealed" });
    const blocks = [...new Set([...context.matchAll(/^<([a-z_]+)[\s>/]/gm)].map((match) => match[1]!))].filter((block) => block !== "chat" && block !== "question");
    expect(blocks).toEqual(expect.arrayContaining(["about_you", "who_is_who", "corrections", "running_jokes", "project_details", "in_focus", "current_conversation", "thread", "your_recent_answers"]));
    for (const model of ["claude-haiku-5-5", "claude-opus-5-5"]) {
      for (const block of blocks) expect(replySystemPrompt(model), block).toContain(`<${block}>`);
    }
  });
});
