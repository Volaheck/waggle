import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { attachLegacyData, getChat, LEGACY_CHAT_ID, registerChat, resumeChronicle, setChatStatus, type Chat } from "../src/core/chats.js";
import { migrateChat } from "../src/core/chat-migration.js";
import { catchupFor, relinkForeignTopics } from "../src/core/chronicle.js";
import { createSql, migrate, type Sql } from "../src/core/db.js";
import { dropFact, mergeFacts, normalizeStacks, proposeFact, rejectFact, rewriteFact, setFactHidden, visibleFacts, type FactKind } from "../src/core/facts.js";
import { detectLanguage } from "../src/core/language.js";
import { assertBudget, BudgetExceededError, canonicalModelId, chatEndUserId, estimateCostUsd, isPricedModel, monthSpendUsd, structuredOutputFormat } from "../src/core/llm.js";
import { clearExpiredTexts, saveMessage, type StoredMessage } from "../src/core/messages.js";
import { NOTE_KINDS, NOTE_STATUSES } from "../src/core/notes.js";
import { mergeProjects, PROJECT_STATUSES, upsertProject } from "../src/core/projects.js";
import { getPerson, peopleOfChat, resolveUser, setOptOut } from "../src/core/users.js";
import { applyConsolidation, CONSOLIDATION_SYSTEM_PROMPT, ConsolidationSchema, consolidationRetryDelayMs, loadConsolidationInput } from "../src/worker/consolidate.js";
import {
  applyExtraction,
  buildExtractionPrompt,
  ExtractionSchema,
  FACT_ADD_KINDS,
  INTERRUPTED_PASS_ERROR,
  runExtractionPass,
  TOPIC_KINDS,
  type BatchData,
  type ExtractionResult,
} from "../src/worker/extract.js";
import { NOTES_SYSTEM_PROMPT, NotesSchema } from "../src/worker/notes-extract.js";
import { chatBudgetUsd, createChatProcessor, extractionRetryDelayMs, nextExtractionRetryAt, startExtractionScheduler, startMessageRetention } from "../src/worker/scheduler.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("LLM spending", () => {
  it("prices dated snapshots and provider ids like the model itself", () => {
    for (const id of ["claude-sonnet-5-5-20261001", "anthropic.claude-sonnet-5-5", "us.anthropic.claude-sonnet-5-5-v1:0", "claude-sonnet-5-5@20261001", "claude-sonnet-5-5[1m]"]) {
      expect(canonicalModelId(id), id).toBe("claude-sonnet-5-5");
    }
    const usage = { input_tokens: 150_000, output_tokens: 32_000 };
    expect(estimateCostUsd("claude-sonnet-5-5-20261001", usage)).toBeCloseTo(0.62, 5);
    expect(estimateCostUsd("claude-sonnet-5", usage)).toBeCloseTo(0.62, 5);
    expect(estimateCostUsd("claude-opus-5", usage)).toBeCloseTo(1.55, 5);
    expect(isPricedModel("claude-opus-5")).toBe(true);
  });

  it("charges a model it does not know at the highest known rate instead of $0", () => {
    expect(isPricedModel("claude-nova-9")).toBe(false);
    expect(estimateCostUsd("claude-nova-9", { input_tokens: 1_000_000, output_tokens: 0 })).toBe(10);
    expect(estimateCostUsd("claude-nova-9", { input_tokens: 0, output_tokens: 1_000_000 })).toBe(50);
  });

  it("bills Claude Haiku 5.5 prompts over 100K tokens on the higher rate card", () => {
    expect(estimateCostUsd("claude-haiku-5-5", { input_tokens: 50_000, output_tokens: 0 })).toBeCloseTo(0.005, 6);
    expect(estimateCostUsd("claude-haiku-5-5", { input_tokens: 150_000, output_tokens: 10_000 })).toBeCloseTo(0.075 + 0.025, 6);
  });
});

function enumsUnder(node: unknown): string[][] {
  if (!node || typeof node !== "object") return [];
  const record = node as Record<string, unknown>;
  const own = Array.isArray(record.enum) ? [record.enum as string[]] : [];
  return [...own, ...Object.values(record).flatMap(enumsUnder)];
}

function objectsWithoutStrictness(node: unknown): number {
  if (!node || typeof node !== "object") return 0;
  const record = node as Record<string, unknown>;
  const own = record.type === "object" && record.additionalProperties !== false ? 1 : 0;
  return own + Object.values(record).reduce<number>((sum, child) => sum + objectsWithoutStrictness(child), 0);
}

describe("structured output format", () => {
  it("holds the model to the enum values and drops constraints the API rejects", () => {
    const format = structuredOutputFormat(ExtractionSchema);
    expect(format.type).toBe("json_schema");
    // No parse hook: a cut-off or refused answer must reach our own checks, with its usage recorded.
    expect("parse" in format).toBe(false);
    const properties = (format.schema as { properties: Record<string, { items: { properties: Record<string, unknown> } }> }).properties;
    expect(enumsUnder(properties.topics!.items.properties.kind)).toEqual([[...TOPIC_KINDS]]);
    expect(enumsUnder(properties.facts_add!.items.properties.kind)).toEqual([[...FACT_ADD_KINDS]]);
    const notes = (structuredOutputFormat(NotesSchema).schema as { properties: Record<string, { items: { properties: Record<string, unknown> } }> }).properties;
    expect(enumsUnder(notes.notes!.items.properties.kind)).toEqual([[...NOTE_KINDS]]);
    expect(enumsUnder(notes.notes!.items.properties.status)).toEqual([[...NOTE_STATUSES]]);
    expect(objectsWithoutStrictness(structuredOutputFormat(NotesSchema).schema)).toBe(0);
    expect(enumsUnder(properties.projects!.items.properties.status)).toEqual([[...PROJECT_STATUSES]]);
    expect(JSON.stringify(format.schema)).not.toMatch(/"(minimum|maximum|\$schema)"/);
    expect(objectsWithoutStrictness(format.schema)).toBe(0);
    expect(enumsUnder(structuredOutputFormat(ConsolidationSchema).schema)).toEqual([[...PROJECT_STATUSES]]);
  });

  it("keeps both extraction schemas small enough for the API to compile", () => {
    // Measured on 2026-11-09 with claude-sonnet-5-5: six of these arrays of objects with a small seventh are accepted, while
    // a seventh array of notes made the API refuse every call ("The compiled grammar is too large"), which tests with a
    // fake client never notice. So the notes have a call of their own. Before adding a field or an array to either,
    // try a real call with the new schema (scripts/print-extraction-formats.ts prints both as they are sent).
    const properties = (structuredOutputFormat(ExtractionSchema).schema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(properties)).toEqual(["topics", "facts_add", "facts_update", "projects", "project_renames", "project_signals"]);
    const notes = (structuredOutputFormat(NotesSchema).schema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(notes)).toEqual(["notes", "aliases"]);
  });
});

describe("chat language by votes", () => {
  const russian = [
    "Кто-нибудь пробовал новый релиз редактора? Говорят, стало быстрее",
    "Да, вчера поставил, пока всё нормально работает",
    "У меня плагины отвалились после обновления, жду фикса",
    "Я пока на старой версии посижу, мне и так хорошо",
    "А кто едет на митап в субботу? Можно вместе",
    "Я буду, но опоздаю на полчаса наверное",
    "Купил новую клавиатуру, печатать одно удовольствие",
    "Какую? Скинь модель, давно хочу механику",
    "Сегодня весь день дебажил утечку памяти в сервисе",
    "Нашёл в итоге? Расскажи потом, что это было",
  ];
  const ukrainian = [
    "Привіт усім! Я теж хочу спробувати цей редактор, він справді швидший?",
    "Мені здається, що нова версія працює краще, але плагіни ще не всі оновили",
    "Я буду на мітапі, якщо встигну після роботи",
  ];

  it("keeps a Russian chat Russian when one member writes Ukrainian or Kazakh", () => {
    expect(detectLanguage([...russian, ...russian, ...ukrainian])).toBe("Russian");
    expect(detectLanguage([...russian, "Сәлеметсіз бе, бүгін кездесуге барамын, қай уақытта басталады?"])).toBe("Russian");
  });

  it("does not let one long pasted text, links or @usernames outvote the members", () => {
    const paste = "This release brings a completely redesigned plugin system, faster startup and many fixes. ".repeat(14);
    expect(detectLanguage([...russian, paste])).toBe("Russian");
    expect(detectLanguage([...russian.slice(0, 2), "https://github.com/example/a-very-long-repository-name", "@someone_here"])).toBe("Russian");
  });

  it("still names a chat that really writes in Ukrainian, and stays silent when it is split", () => {
    expect(detectLanguage([...ukrainian, ...ukrainian, russian[0]!])).toBe("Ukrainian");
    expect(detectLanguage([...russian.slice(0, 3), ...ukrainian])).toBeNull();
  });
});

describe("retry back-off", () => {
  it("doubles the pause after each failed chronicler pass, up to a day", () => {
    expect([1, 2, 3, 6, 10].map(extractionRetryDelayMs)).toEqual([HOUR, 2 * HOUR, 4 * HOUR, 24 * HOUR, 24 * HOUR]);
  });

  it("waits longer after each failed clean-up, up to a week", () => {
    expect([1, 2, 3, 6].map(consolidationRetryDelayMs)).toEqual([HOUR, 4 * HOUR, 16 * HOUR, 7 * DAY]);
  });
});

interface FakeAnswer {
  stopReason?: "end_turn" | "max_tokens" | "refusal";
  text?: string;
  usage?: { input_tokens: number; output_tokens: number };
  /** The stream breaks after it started. */
  breaks?: boolean;
}

const EMPTY_NOTES = JSON.stringify({ notes: [], aliases: [] });

/** Each pass makes a second call for the private notes after a batch is applied; unless `notes` says otherwise, it finds none. */
function fakeAnthropic(answer: (request: { system: string; prompt: string }) => FakeAnswer, notes: (request: { system: string; prompt: string }) => FakeAnswer = () => ({ text: EMPTY_NOTES })) {
  const requests: { system: string; prompt: string; userId?: string }[] = [];
  const client = {
    messages: {
      stream(params: { system: string; messages: { content: string }[]; metadata?: { user_id?: string } }) {
        const request = { system: params.system, prompt: params.messages[0]!.content, userId: params.metadata?.user_id };
        requests.push(request);
        const reply = request.system === NOTES_SYSTEM_PROMPT ? notes(request) : answer(request);
        const message = {
          stop_reason: reply.stopReason ?? "end_turn",
          stop_details: reply.stopReason === "refusal" ? { type: "refusal", category: "cyber", explanation: null } : null,
          content: reply.text === undefined ? [] : [{ type: "text", text: reply.text }],
          usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...(reply.usage ?? { input_tokens: 10_000, output_tokens: 1_000 }) },
        };
        return {
          currentMessage: message,
          finalMessage: async () => {
            if (reply.breaks) throw new Error("socket hang up");
            return message;
          },
        };
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

/** The line that opens a day among the messages the chronicler is sent (UTC when no time zone is set). */
const dayLine = (at: Date) => `--- ${at.toLocaleDateString("en-CA", { timeZone: "UTC" })}, ${at.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })} ---`;
/** A chronicler's line with its time left out: «[4 12:30] Bob» → «[4] Bob». */
const untimed = (line: string) => line.replace(/^\[(\d+) \d{2}:\d{2}\]/, "[$1]");

const EMPTY_EXTRACTION: ExtractionResult = { topics: [], facts_add: [], facts_update: [], projects: [], project_renames: [], project_signals: [] };
const EMPTY_CLEANUP = JSON.stringify({ fact_merges: [], fact_drops: [], project_merges: [], project_updates: [] });
const MODEL = "claude-sonnet-5-5";
/** 10K input and 1K output tokens at Sonnet 5.5 prices. */
const CALL_COST = 0.03;

describe.skipIf(!DATABASE_URL)("pipeline with postgres", () => {
  let sql: Sql;
  let nextChat = -1001000000100;
  let nextTgId = 70_000;

  beforeAll(async () => {
    sql = createSql(DATABASE_URL!);
    await sql`DROP SCHEMA public CASCADE`;
    await sql`CREATE SCHEMA public`;
    await migrate(sql);
  });

  afterAll(async () => {
    await sql?.end();
  });

  async function newChat(title: string): Promise<Chat> {
    nextChat -= 1;
    await registerChat(sql, nextChat, title, null);
    return (await setChatStatus(sql, nextChat, "approved", null))!;
  }

  async function person(chatId: number, firstName: string, lastName?: string) {
    nextTgId += 1;
    return resolveUser(sql, { id: nextTgId, first_name: firstName, last_name: lastName }, [], chatId);
  }

  async function message(chatId: number, msgId: number, userId: number | null, text: string, sentAt = new Date(Date.now() - 7 * HOUR)) {
    await saveMessage(sql, { chatId, msgId, userId, sentAt, text, replyToMsgId: null, isForward: false, forwardSource: null, mediaType: null });
  }

  async function project(chatId: number, slug: string, name: string, authorIds: number[]): Promise<number> {
    const [row] = await sql<{ id: number }[]>`INSERT INTO projects (chat_id, slug, name) VALUES (${chatId}, ${slug}, ${name}) RETURNING id`;
    for (const userId of authorIds) await sql`INSERT INTO project_members (project_id, user_id) VALUES (${row!.id}, ${userId})`;
    return row!.id;
  }

  async function fact(chatId: number, userId: number, kind: FactKind, value: string, status: "auto" | "manual" | "hidden" | "deprecated" = "auto"): Promise<number> {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO facts (chat_id, user_id, kind, value, value_norm, confidence, status, source_msg_ids)
      VALUES (${chatId}, ${userId}, ${kind}, ${value}, ${value.toLowerCase()}, 0.9, ${status}, '{1}')
      RETURNING id`;
    return row!.id;
  }

  async function newRun(chatId: number): Promise<number> {
    const [run] = await sql<{ id: number }[]>`INSERT INTO extraction_runs (chat_id) VALUES (${chatId}) RETURNING id`;
    return run!.id;
  }

  async function pendingCount(chatId: number): Promise<number> {
    const [row] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM messages WHERE chat_id = ${chatId} AND extracted_at IS NULL`;
    return row!.count;
  }

  async function usageRows(chatId: number): Promise<number> {
    const [row] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM llm_usage WHERE chat_id = ${chatId}`;
    return row!.count;
  }

  const deps = (chatId: number, anthropic: Anthropic, budget = { chat: 50, total: 500 }) => ({
    sql,
    anthropic,
    chatId,
    chatBudgetUsd: budget.chat,
    config: { EXTRACTION_MODEL: MODEL, MONTHLY_LLM_BUDGET_USD: budget.total },
  });

  it("links a topic only to a project of its own chat, including one the same batch created", async () => {
    const other = await newChat("Other chat");
    const chat = await newChat("Chronicled chat");
    const stranger = await person(other.id, "Stranger");
    const anna = await person(chat.id, "Anna");
    // The other chat's rows are older, so a lookup by slug alone would find them first.
    const otherAtlas = await project(other.id, "atlas", "Atlas", [stranger.id]);
    await project(other.id, "orbit", "Orbit", [stranger.id]);
    const atlas = await project(chat.id, "atlas", "Atlas", [anna.id]);
    await message(chat.id, 11, anna.id, "Shipped Atlas 2.0 tonight");
    await message(chat.id, 12, anna.id, "And I started Orbit, a tiny habit tracker");
    const result: ExtractionResult = {
      ...EMPTY_EXTRACTION,
      topics: [
        { title: "Atlas 2.0 shipped", summary: "Anna shipped Atlas 2.0.", kind: "project", importance: 4, project: "atlas", msg_ids: [11] },
        { title: "Orbit started", summary: "Anna started Orbit.", kind: "project", importance: 3, project: "orbit", msg_ids: [12] },
      ],
      projects: [{ slug: "orbit", name: "Orbit", tagline: null, status: "idea", stack: [], repo: null, site: null, authors: [`u${anna.id}`], confidence: 0.9, source_msg_ids: [12] }],
    };
    const { client } = fakeAnthropic(() => ({ text: JSON.stringify(result) }));
    await runExtractionPass(deps(chat.id, client));

    const topics = await sql<{ title: string; project_chat: number | null; project_id: number | null }[]>`
      SELECT c.title, p.chat_id AS project_chat, c.project_id FROM chronicle c LEFT JOIN projects p ON p.id = c.project_id
      WHERE c.chat_id = ${chat.id} ORDER BY c.id`;
    expect(topics.map((topic) => topic.project_chat)).toEqual([chat.id, chat.id]);
    expect(topics[0]!.project_id).toBe(atlas);
    const [foreign] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM chronicle WHERE project_id = ${otherAtlas}`;
    expect(foreign!.count).toBe(0);
  });

  it("sends a topic and a signal about a merged-away duplicate to the project it was merged into", async () => {
    const chat = await newChat("Merged duplicates");
    const anna = await person(chat.id, "Anna");
    const bob = await person(chat.id, "Bob");
    const keeper = await project(chat.id, "lumen", "Lumen", [anna.id]);
    await project(chat.id, "lumen-app", "Lumen app", [anna.id]);
    expect(await mergeProjects(sql, chat.id, "lumen", ["lumen-app"])).toBe(1);
    await message(chat.id, 21, bob.id, "Lumen app is great, I use it every day");
    const result: ExtractionResult = {
      ...EMPTY_EXTRACTION,
      topics: [{ title: "Lumen praised", summary: "Bob uses Lumen every day.", kind: "project", importance: 2, project: "lumen-app", msg_ids: [21] }],
      project_signals: [{ project: "lumen-app", person: `u${bob.id}`, kind: "usage", impact: 3, note: "Bob uses it every day", source_msg_ids: [21] }],
    };
    const { client } = fakeAnthropic(() => ({ text: JSON.stringify(result) }));
    await runExtractionPass(deps(chat.id, client));
    expect((await sql<{ project_id: number | null }[]>`SELECT project_id FROM chronicle WHERE chat_id = ${chat.id}`).map((row) => row.project_id)).toEqual([keeper]);
    expect((await sql<{ project_id: number }[]>`SELECT project_id FROM project_signals WHERE user_id = ${bob.id}`).map((row) => row.project_id)).toEqual([keeper]);
  });

  it("never makes a member who opted out an author of the chronicler's project", async () => {
    const chat = await newChat("Opted-out authors");
    const anna = await person(chat.id, "Anna");
    const quiet = await person(chat.id, "Quiet");
    await setOptOut(sql, quiet.id, true, chat.id);
    const authors = async (projectId: number) =>
      (await sql<{ user_id: number }[]>`SELECT user_id FROM project_members WHERE project_id = ${projectId}`).map((row) => row.user_id);
    const created = await upsertProject(sql, { chatId: chat.id, name: "Tally", authorIds: [anna.id, quiet.id], sourceMsgIds: [], source: "llm" });
    expect(await authors(created.project.id)).toEqual([anna.id]);
    const again = await upsertProject(sql, { chatId: chat.id, name: "Tally", authorIds: [quiet.id], sourceMsgIds: [], source: "llm" });
    expect(again).toMatchObject({ created: false, changed: false });
    expect(await authors(created.project.id)).toEqual([anna.id]);
  });

  it("keeps the first copy of a message Telegram delivers twice", async () => {
    const chat = await newChat("Redelivered updates");
    const anna = await person(chat.id, "Anna");
    await message(chat.id, 31, anna.id, "Have a look at https://example.org/tool");
    await message(chat.id, 31, anna.id, "Have a look at https://example.org/tool, again");
    expect(await sql`SELECT text FROM messages WHERE chat_id = ${chat.id}`).toEqual([{ text: "Have a look at https://example.org/tool" }]);
  });

  it("clears the texts of processed messages past the retention period, and nothing else", async () => {
    const chat = await newChat("Retention");
    const anna = await person(chat.id, "Anna");
    const longAgo = new Date(Date.now() - 40 * DAY);
    const save = (msgId: number, text: string, sentAt: Date, forwardedFrom: string | null = null) =>
      saveMessage(sql, { chatId: chat.id, msgId, userId: anna.id, sentAt, text, replyToMsgId: null, isForward: forwardedFrom !== null, forwardSource: forwardedFrom, mediaType: null });
    await save(1, "Old and processed", longAgo);
    await save(2, "Old, still waiting for the chronicler", longAgo);
    await save(3, "Recent and processed", new Date(Date.now() - 2 * DAY));
    await save(4, "Forwarded long ago", longAgo, "Tech News");
    await sql`UPDATE messages SET extracted_at = now() WHERE chat_id = ${chat.id} AND msg_id IN (1, 3, 4)`;

    expect(await clearExpiredTexts(sql, 30)).toBe(2);
    expect(await sql`SELECT msg_id, user_id, text, is_forward, forward_source FROM messages WHERE chat_id = ${chat.id} ORDER BY msg_id`).toEqual([
      { msg_id: 1, user_id: anna.id, text: "", is_forward: false, forward_source: null },
      { msg_id: 2, user_id: anna.id, text: "Old, still waiting for the chronicler", is_forward: false, forward_source: null },
      { msg_id: 3, user_id: anna.id, text: "Recent and processed", is_forward: false, forward_source: null },
      { msg_id: 4, user_id: anna.id, text: "", is_forward: true, forward_source: null },
    ]);
    // Full-text search forgets a cleared text as well.
    expect(await sql`SELECT msg_id FROM messages WHERE chat_id = ${chat.id} AND tsv @@ plainto_tsquery('russian', 'processed')`).toEqual([{ msg_id: 3 }]);
    expect(await clearExpiredTexts(sql, 30)).toBe(0);

    // The waiting message goes the same way once the chronicler has been through it.
    await sql`UPDATE messages SET extracted_at = now() WHERE chat_id = ${chat.id} AND msg_id = 2`;
    expect(await clearExpiredTexts(sql, 30)).toBe(1);
  });

  it("starts clearing expired texts at once, and stops when told", async () => {
    const chat = await newChat("Retention timer");
    const anna = await person(chat.id, "Anna");
    await message(chat.id, 1, anna.id, "An old processed message", new Date(Date.now() - 40 * DAY));
    await sql`UPDATE messages SET extracted_at = now() WHERE chat_id = ${chat.id}`;
    const lines: string[] = [];
    const stop = startMessageRetention(sql, 30, (line) => lines.push(line));
    await vi.waitFor(() => expect(lines).toEqual(["[retention] cleared the text of 1 processed message(s) older than 30 days"]));
    stop();
    expect((await sql<{ text: string }[]>`SELECT text FROM messages WHERE chat_id = ${chat.id}`)[0]!.text).toBe("");
  });

  it("leaves cleared texts out of the chronicler's context and the /catchup mentions", async () => {
    const chat = await newChat("Cleared texts");
    const anna = await person(chat.id, "Anna");
    const bob = await person(chat.id, "Bob");
    const save = (msgId: number, userId: number, text: string, extra: { replyTo?: number; media?: string } = {}) =>
      saveMessage(sql, { chatId: chat.id, msgId, userId, sentAt: new Date(Date.now() - 2 * HOUR), text, replyToMsgId: extra.replyTo ?? null, isForward: false, forwardSource: null, mediaType: extra.media ?? null });
    await save(1, anna.id, "Anyone up for a board game tonight?");
    await save(2, bob.id, "This text gets cleared", { replyTo: 1 });
    await save(3, bob.id, "", { replyTo: 1, media: "sticker" });
    await save(4, bob.id, "Count me in", { replyTo: 1 });
    await sql`UPDATE messages SET extracted_at = now() WHERE chat_id = ${chat.id}`;
    // As clearExpiredTexts leaves it.
    await sql`UPDATE messages SET text = '' WHERE chat_id = ${chat.id} AND msg_id = 2`;
    await save(5, anna.id, "Great, see you at eight then");

    const { client, requests } = fakeAnthropic(() => ({ text: JSON.stringify(EMPTY_EXTRACTION) }));
    await runExtractionPass(deps(chat.id, client));
    const context = /<context>\n([\s\S]*?)\n<\/context>/.exec(requests[0]!.prompt)![1]!.split("\n").map(untimed);
    expect(context).toEqual([dayLine(new Date(Date.now() - 2 * HOUR)), `[1] Anna (u${anna.id}): Anyone up for a board game tonight?`, `[3] Bob (u${bob.id}) ↩1 [sticker]`, `[4] Bob (u${bob.id}) ↩1: Count me in`]);

    const catchup = await catchupFor(sql, chat.id, (await getPerson(sql, chat.id, anna.id))!, 24);
    expect(catchup.mentions.map((mention) => mention.msg_id)).toEqual([4, 3]);
  });

  it("shows the chronicler which messages answer the bot's own posts", async () => {
    const chat = await newChat("Replies to the bot");
    const anna = await person(chat.id, "Anna");
    const sentAt = new Date(Date.now() - 2 * HOUR);
    const save = (msgId: number, text: string, replyToMsgId: number | null, replyToBot?: boolean) =>
      saveMessage(sql, { chatId: chat.id, msgId, userId: anna.id, sentAt, text, replyToMsgId, replyToBot, isForward: false, forwardSource: null, mediaType: null });
    await save(1, "Who wants to try my new app?", null);
    await save(3, "The most honest description of all", 2, true);
    await save(4, "I mean the card above", 3);

    const { client, requests } = fakeAnthropic(() => ({ text: JSON.stringify(EMPTY_EXTRACTION) }));
    await runExtractionPass(deps(chat.id, client));
    const batch = /<new_messages>\n([\s\S]*?)\n<\/new_messages>/.exec(requests[0]!.prompt)![1]!.split("\n").map(untimed);
    expect(batch).toEqual([
      dayLine(sentAt),
      `[1] Anna (u${anna.id}): Who wants to try my new app?`,
      `[3] Anna (u${anna.id}) ↩bot: The most honest description of all`,
      `[4] Anna (u${anna.id}) ↩3: I mean the card above`,
    ]);
  });

  it("points topics an earlier version linked across chats at the chat's own project", async () => {
    const other = await newChat("Leaky source");
    const chat = await newChat("Leaky target");
    const own = await project(chat.id, "comet", "Comet", []);
    const foreignComet = await project(other.id, "comet", "Comet", []);
    const foreignOnly = await project(other.id, "nebula", "Nebula", []);
    const imported = await project(LEGACY_CHAT_ID, "legacy-only", "Legacy only", []);
    const topic = async (projectId: number) =>
      (await sql<{ id: number }[]>`
        INSERT INTO chronicle (chat_id, run_id, period_from, period_to, title, summary, project_id)
        VALUES (${chat.id}, 0, now(), now(), 'Topic', 'Summary', ${projectId}) RETURNING id`)[0]!.id;
    const [toComet, toNebula, toImport] = [await topic(foreignComet), await topic(foreignOnly), await topic(imported)];

    expect(await relinkForeignTopics(sql)).toBe(2);
    const links = new Map((await sql<{ id: number; project_id: number | null }[]>`SELECT id, project_id FROM chronicle WHERE id = ANY(${[toComet, toNebula, toImport]})`).map((row) => [row.id, row.project_id]));
    expect(links.get(toComet)).toBe(own);
    expect(links.get(toNebula)).toBeNull();
    // Attaching the import makes this one valid; until then it is left alone.
    expect(links.get(toImport)).toBe(imported);
    await sql`DELETE FROM chronicle WHERE id = ${toImport}`;
    await sql`DELETE FROM projects WHERE id = ${imported}`;
  });

  it("masks personal data in what the chronicler is sent and names the chat to Anthropic only by an opaque id", async () => {
    const chat = await newChat("Masked prompt");
    const author = await person(chat.id, "Writer");
    await message(chat.id, 1, author.id, "Мой номер +7 (912) 345-67-89, почта ivan.petrov@gmail.com, репо https://github.com/acme/atlas");
    await message(chat.id, 2, author.id, "А рабочий +7 900\n123 45 67");
    const { client, requests } = fakeAnthropic(() => ({ text: JSON.stringify(EMPTY_EXTRACTION) }));
    const endUserId = chatEndUserId("test-secret", chat.id);
    await runExtractionPass({ ...deps(chat.id, client), endUserId });
    // The notes call that follows is sent the same masked messages, for the same end user.
    expect(requests.map((request) => request.system === NOTES_SYSTEM_PROMPT)).toEqual([false, true]);
    for (const request of requests) {
      expect(request.prompt).toContain("Мой номер [phone], почта [email], репо https://github.com/acme/atlas");
      expect(request.prompt).toContain("А рабочий [phone]");
      expect(request.prompt).not.toMatch(/912|ivan\.petrov|900/);
      expect(request.userId).toBe(endUserId);
    }
    expect(endUserId).toMatch(/^[0-9a-f]{32}$/);
    expect(endUserId).not.toContain(String(Math.abs(chat.id)));
    expect(chatEndUserId("test-secret", chat.id - 1)).not.toBe(endUserId);
    // The text stays as written for the chat's own members.
    const [stored] = await sql<{ text: string }[]>`SELECT text FROM messages WHERE chat_id = ${chat.id} AND msg_id = 1`;
    expect(stored!.text).toContain("+7 (912) 345-67-89");
  });

  it("splits a batch the model keeps refusing, skips only the slice it refuses and pays for every call", async () => {
    const chat = await newChat("Refusals");
    const author = await person(chat.id, "Writer");
    for (let msgId = 1001; msgId <= 1040; msgId += 1) {
      await message(chat.id, msgId, author.id, msgId === 1025 ? "FORBIDDEN-MARKER: how to break into a server" : `Message ${msgId} about the weekly build`);
    }
    const { client, requests } = fakeAnthropic(({ prompt }) => (prompt.includes("FORBIDDEN-MARKER") ? { stopReason: "refusal", text: '{"topics": [' } : { text: JSON.stringify(EMPTY_EXTRACTION) }));
    const result = await runExtractionPass(deps(chat.id, client));

    // Refused, the 40 messages are cut into slices of 10, so the refused message is sent twice rather than three times.
    // Each of the three slices applied gets its notes call, which never sees the refused message either.
    expect(result.calls).toBe(5);
    expect(result.failedCalls).toBe(2);
    expect(result.refusals).toBe(2);
    expect(result.notesCalls).toBe(3);
    expect(result.notesFailures).toEqual([]);
    expect(result.skipped).toEqual([{ firstMsgId: 1021, lastMsgId: 1030, messages: 10, reason: "the model refused (cyber)", refusal: true }]);
    expect(await pendingCount(chat.id)).toBe(0);
    expect(await usageRows(chat.id)).toBe(8);
    expect(await monthSpendUsd(sql, chat.id)).toBeCloseTo(8 * CALL_COST, 5);
    expect(requests.filter((request) => request.system === NOTES_SYSTEM_PROMPT && request.prompt.includes("FORBIDDEN-MARKER"))).toEqual([]);
    const [run] = await sql<{ status: string; stats: { skipped: unknown[] } }[]>`SELECT status, stats FROM extraction_runs WHERE chat_id = ${chat.id}`;
    expect(run!.status).toBe("done");
    expect(run!.stats.skipped).toHaveLength(1);
    // The batch after the skipped slice does not see the refused message in its context either.
    expect(requests.at(-1)!.prompt).not.toContain("FORBIDDEN-MARKER");

    await message(chat.id, 1041, author.id, "Next day: the build is green again");
    const later = await runExtractionPass(deps(chat.id, client));
    expect(later.failedCalls).toBe(0);
    expect(requests.at(-1)!.prompt).not.toContain("FORBIDDEN-MARKER");
  });

  it("starts no new call once the bot is stopping, and a cancelled call still counts as spending", async () => {
    const chat = await newChat("Stopping bot");
    const author = await person(chat.id, "Writer");
    for (let msgId = 1; msgId <= 40; msgId += 1) await message(chat.id, msgId, author.id, `Message ${msgId} about the release`);
    const failedRun = async () =>
      (await sql<{ status: string; error: string }[]>`SELECT status, error FROM extraction_runs WHERE chat_id = ${chat.id} ORDER BY id DESC LIMIT 1`)[0];

    // The stop begins while the first call is answered (with a refusal that would make the pass split the batch).
    const drain = new AbortController();
    const { client, requests } = fakeAnthropic(() => {
      drain.abort();
      return { stopReason: "refusal", text: "" };
    });
    await expect(runExtractionPass({ ...deps(chat.id, client), drain: drain.signal })).rejects.toThrow(INTERRUPTED_PASS_ERROR);
    expect(requests).toHaveLength(1);
    expect(await failedRun()).toEqual({ status: "failed", error: INTERRUPTED_PASS_ERROR });
    expect(await pendingCount(chat.id)).toBe(40);
    expect(await usageRows(chat.id)).toBe(1);

    // A call still running when the stop can wait no longer is cancelled; the input it was sent is paid for. The stop
    // comes once the call is under way, however long the pass takes to get there.
    const cancel = new AbortController();
    let callStarted!: () => void;
    const underWay = new Promise<void>((resolve) => (callStarted = resolve));
    const hanging = {
      messages: {
        stream(_params: unknown, options?: { signal?: AbortSignal }) {
          callStarted();
          return {
            currentMessage: { usage: { input_tokens: 50_000, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
            finalMessage: () => new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("Request was aborted.")))),
          };
        },
      },
    } as unknown as Anthropic;
    const pass = runExtractionPass({ ...deps(chat.id, hanging), signal: cancel.signal });
    await underWay;
    cancel.abort();
    await expect(pass).rejects.toThrow("aborted");
    expect(await failedRun()).toEqual({ status: "failed", error: INTERRUPTED_PASS_ERROR });
    expect(await usageRows(chat.id)).toBe(2);
    expect(await pendingCount(chat.id)).toBe(40);

    // A chat processed after the stop began gets no pass, no clean-up and no alert.
    const alerts: string[] = [];
    const quiet = fakeAnthropic(() => ({ text: JSON.stringify(EMPTY_EXTRACTION) }));
    const stopped = new AbortController();
    stopped.abort();
    const processChat = createChatProcessor(
      {
        sql,
        anthropic: quiet.client,
        config: { EXTRACTION_MODEL: MODEL, MONTHLY_LLM_BUDGET_USD: 500, CHAT_MONTHLY_BUDGET_USD: 50, EXTRACTION_INTERVAL_HOURS: 6, EXTRACTION_PASS_MESSAGES: 200, EXTRACTION_MIN_GAP_MINUTES: 60 },
        notifyAdmins: async (text) => void alerts.push(text),
        log: () => {},
      },
      { drain: stopped.signal, abort: new AbortController().signal },
    );
    await sql`DELETE FROM extraction_runs WHERE chat_id = ${chat.id}`;
    await processChat(chat);
    expect(quiet.requests).toHaveLength(0);
    expect(alerts).toEqual([]);
  });

  it("records a cut-off, an unreadable or a broken answer as spending", async () => {
    const chat = await newChat("Broken answers");
    const author = await person(chat.id, "Talker");
    await message(chat.id, 1, author.id, "A long story about the deploy pipeline");
    const cutOff = fakeAnthropic(() => ({ stopReason: "max_tokens", text: '{"topics": [{"title": "unterminated' }));
    const first = await runExtractionPass(deps(chat.id, cutOff.client));
    expect(first.skipped.map((range) => range.reason)).toEqual(["the answer did not fit into max_tokens"]);
    expect(await usageRows(chat.id)).toBe(1);

    await message(chat.id, 2, author.id, "Another long story about the same pipeline");
    const unreadable = fakeAnthropic(() => ({ text: "{not json" }));
    expect((await runExtractionPass(deps(chat.id, unreadable.client))).skipped).toHaveLength(1);
    expect(await usageRows(chat.id)).toBe(2);

    await message(chat.id, 3, author.id, "And a third story, while the network drops");
    const broken = fakeAnthropic(() => ({ breaks: true, usage: { input_tokens: 12_000, output_tokens: 0 } }));
    await expect(runExtractionPass(deps(chat.id, broken.client))).rejects.toThrow("socket hang up");
    expect(await usageRows(chat.id)).toBe(3);
    expect(await pendingCount(chat.id)).toBe(1);
    const [run] = await sql<{ status: string; first_msg_id: number }[]>`SELECT status, first_msg_id FROM extraction_runs WHERE chat_id = ${chat.id} ORDER BY id DESC LIMIT 1`;
    expect(run).toEqual({ status: "failed", first_msg_id: 3 });
  });

  it("stops at the budget caps before calling the model", async () => {
    const capped = await newChat("Capped");
    const free = await newChat("Free");
    for (const chat of [capped, free]) {
      const author = await person(chat.id, "Budget writer");
      await message(chat.id, 1, author.id, "Something worth chronicling happened today");
    }
    await sql`INSERT INTO llm_usage (chat_id, purpose, model, input_tokens, output_tokens, cost_usd) VALUES (${capped.id}, 'extract', ${MODEL}, 0, 0, 2)`;
    // Last month's spending does not count.
    await sql`
      INSERT INTO llm_usage (at, chat_id, purpose, model, input_tokens, output_tokens, cost_usd)
      VALUES (date_trunc('month', now()) - interval '1 day', ${free.id}, 'extract', ${MODEL}, 0, 0, 999)`;
    expect(await monthSpendUsd(sql, free.id)).toBe(0);

    const { client, requests } = fakeAnthropic(() => ({ text: JSON.stringify(EMPTY_EXTRACTION) }));
    const runsBefore = (await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM extraction_runs`)[0]!.count;
    const error = await runExtractionPass(deps(capped.id, client, { chat: 2, total: 500 })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect((error as BudgetExceededError).chatId).toBe(capped.id);
    expect(requests).toHaveLength(0);
    // A paused budget is not a failed pass: nothing is recorded that would stretch the retry back-off.
    expect((await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM extraction_runs`)[0]!.count).toBe(runsBefore);

    expect((await runExtractionPass(deps(free.id, client, { chat: 2, total: 500 }))).calls).toBe(1);

    const total = await monthSpendUsd(sql);
    const overall = await assertBudget(sql, total, { id: free.id, limitUsd: 100 }).catch((caught: unknown) => caught);
    expect(overall).toBeInstanceOf(BudgetExceededError);
    expect((overall as BudgetExceededError).chatId).toBeUndefined();

    await sql`UPDATE chats SET monthly_budget_usd = '50.00' WHERE id = ${capped.id}`;
    expect(chatBudgetUsd((await getChat(sql, capped.id))!, 20)).toBe(50);
    expect(chatBudgetUsd(free, 20)).toBe(20);
  });

  it("warns about the first refused slice and pauses the chat at the second, until an owner resumes it", async () => {
    const chat = await newChat("Refused content");
    const author = await person(chat.id, "Writer");
    const write = async (from: number, marker: number | null) => {
      for (let msgId = from; msgId < from + 20; msgId += 1) {
        await message(chat.id, msgId, author.id, msgId === marker ? "FORBIDDEN-MARKER: something the model refuses" : `Message ${msgId} about the release`);
      }
    };
    const { client, requests } = fakeAnthropic(({ system, prompt }) =>
      system === CONSOLIDATION_SYSTEM_PROMPT ? { text: EMPTY_CLEANUP } : prompt.includes("FORBIDDEN-MARKER") ? { stopReason: "refusal", text: "" } : { text: JSON.stringify(EMPTY_EXTRACTION) },
    );
    const alerts: { text: string; offer?: { resumeChatId: number } }[] = [];
    const processChat = createChatProcessor({
      sql,
      anthropic: client,
      config: { EXTRACTION_MODEL: MODEL, MONTHLY_LLM_BUDGET_USD: 500, CHAT_MONTHLY_BUDGET_USD: 50, EXTRACTION_INTERVAL_HOURS: 6, EXTRACTION_PASS_MESSAGES: 200, EXTRACTION_MIN_GAP_MINUTES: 60 },
      notifyAdmins: async (text, offer) => void alerts.push({ text, offer }),
      endUserIdOf: (chatId) => chatEndUserId("test-secret", chatId),
      log: () => {},
    });
    const fresh = async () => (await getChat(sql, chat.id))!;
    const extractionCalls = () => requests.filter((request) => request.system !== CONSOLIDATION_SYSTEM_PROMPT).length;
    const passLater = () => sql`UPDATE extraction_runs SET started_at = started_at - interval '7 hours', finished_at = finished_at - interval '7 hours' WHERE chat_id = ${chat.id}`;

    await write(1, 5);
    await processChat(await fresh());
    expect(requests.every((request) => request.userId === chatEndUserId("test-secret", chat.id))).toBe(true);
    expect((await fresh()).chronicle_paused_at).toBeNull();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.text).toContain("Claude refused to process 10 message(s)");
    expect(alerts[0]!.text).toContain("If it keeps refusing");
    expect(alerts[0]!.offer).toBeUndefined();

    await passLater();
    await write(101, 105);
    await processChat(await fresh());
    const paused = await fresh();
    expect(paused.chronicle_paused_at).not.toBeNull();
    expect(alerts.at(-1)!.text).toContain("I paused the chronicler");
    expect(alerts.at(-1)!.offer).toEqual({ resumeChatId: chat.id });

    // While paused, new messages wait and nothing goes to Claude.
    await passLater();
    await write(201, null);
    const before = extractionCalls();
    await processChat(paused);
    expect(extractionCalls()).toBe(before);
    expect(await pendingCount(chat.id)).toBe(20);

    // Resumed, the waiting messages are processed, and the refusals before the resume no longer count.
    expect(await resumeChronicle(sql, chat.id)).toBe(true);
    await processChat(await fresh());
    expect(await pendingCount(chat.id)).toBe(0);
    await passLater();
    await write(301, 305);
    await processChat(await fresh());
    expect((await fresh()).chronicle_paused_at).toBeNull();
    expect(alerts.at(-1)!.text).toContain("If it keeps refusing");
  });

  it("pauses a chat whose pass fails on refusals, and carries the pause over a supergroup upgrade", async () => {
    const chat = await newChat("Refuses everything");
    const author = await person(chat.id, "Writer");
    for (let msgId = 1; msgId <= 200; msgId += 1) await message(chat.id, msgId, author.id, `Message ${msgId}`);
    // Something in the catalog or on a card makes the model refuse every call, so nothing narrows down to a message.
    const { client, requests } = fakeAnthropic(() => ({ stopReason: "refusal", text: "" }));
    const alerts: { text: string; offer?: { resumeChatId: number } }[] = [];
    const processChat = createChatProcessor({
      sql,
      anthropic: client,
      config: { EXTRACTION_MODEL: MODEL, MONTHLY_LLM_BUDGET_USD: 500, CHAT_MONTHLY_BUDGET_USD: 50, EXTRACTION_INTERVAL_HOURS: 6, EXTRACTION_PASS_MESSAGES: 200, EXTRACTION_MIN_GAP_MINUTES: 60 },
      notifyAdmins: async (text, offer) => void alerts.push({ text, offer }),
      log: () => {},
    });
    await processChat(chat);
    const [run] = await sql<{ status: string }[]>`SELECT status FROM extraction_runs WHERE chat_id = ${chat.id} ORDER BY id DESC LIMIT 1`;
    const paused = (await getChat(sql, chat.id))!;
    expect(paused.chronicle_paused_at).not.toBeNull();
    expect(alerts.find((alert) => alert.offer)?.text).toContain("I paused the chronicler");
    // Paused, the chat makes no more calls, not even the weekly clean-up.
    const made = requests.length;
    await sql`UPDATE extraction_runs SET started_at = started_at - interval '2 days', finished_at = finished_at - interval '2 days' WHERE chat_id = ${chat.id}`;
    await processChat(paused);
    expect(requests).toHaveLength(made);
    expect(["done", "failed"]).toContain(run!.status);

    const upgraded = chat.id - 900_000;
    await migrateChat(sql, chat.id, upgraded);
    expect((await getChat(sql, upgraded))!.chronicle_paused_at).not.toBeNull();
  });

  it("backs off a failing clean-up instead of paying for it on every tick", async () => {
    const chat = await newChat("Clean-up failures");
    const owner = await person(chat.id, "Card owner");
    await proposeFact(sql, { chatId: chat.id, userId: owner.id, kind: "role", value: "backend developer", confidence: 0.9, sourceMsgIds: [1], source: "llm" });
    let cleanup: FakeAnswer = { stopReason: "max_tokens", text: '{"fact_merges": [' };
    const { client, requests } = fakeAnthropic(() => cleanup);
    const alerts: string[] = [];
    const processChat = createChatProcessor({
      sql,
      anthropic: client,
      config: { EXTRACTION_MODEL: MODEL, MONTHLY_LLM_BUDGET_USD: 500, CHAT_MONTHLY_BUDGET_USD: 50, EXTRACTION_INTERVAL_HOURS: 6, EXTRACTION_PASS_MESSAGES: 200, EXTRACTION_MIN_GAP_MINUTES: 60 },
      notifyAdmins: async (text) => void alerts.push(text),
      log: () => {},
    });
    const attemptKey = `consolidation_attempt:${chat.id}`;

    await processChat(chat);
    await processChat(chat);
    expect(requests).toHaveLength(1);
    expect(await usageRows(chat.id)).toBe(1);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("Next attempt in about 1 h");

    await sql`UPDATE app_state SET updated_at = now() - interval '2 hours' WHERE key = ${attemptKey}`;
    await processChat(chat);
    expect(requests).toHaveLength(2);
    await processChat(chat);
    expect(requests).toHaveLength(2);

    // The second failure waits 4 h; after it, a good answer ends the failure streak.
    await sql`UPDATE app_state SET updated_at = now() - interval '5 hours' WHERE key = ${attemptKey}`;
    cleanup = { text: EMPTY_CLEANUP };
    await processChat(chat);
    expect(requests).toHaveLength(3);
    const [done] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM app_state WHERE key = ${`last_consolidation:${chat.id}`}`;
    expect(done!.count).toBe(1);
    await processChat(chat);
    expect(requests).toHaveLength(3);
  });

  it("runs the clean-up even when the chronicler pass fails, and backs the pass off", async () => {
    const chat = await newChat("Failing chronicler");
    const author = await person(chat.id, "Busy writer");
    await message(chat.id, 1, author.id, "A message the chronicler will not get through");
    await proposeFact(sql, { chatId: chat.id, userId: author.id, kind: "interest", value: "chess", confidence: 0.9, sourceMsgIds: [1], source: "llm" });
    const { client, requests } = fakeAnthropic(({ system }) => (system === CONSOLIDATION_SYSTEM_PROMPT ? { text: EMPTY_CLEANUP } : { breaks: true }));
    const alerts: string[] = [];
    const processChat = createChatProcessor({
      sql,
      anthropic: client,
      config: { EXTRACTION_MODEL: MODEL, MONTHLY_LLM_BUDGET_USD: 500, CHAT_MONTHLY_BUDGET_USD: 50, EXTRACTION_INTERVAL_HOURS: 6, EXTRACTION_PASS_MESSAGES: 200, EXTRACTION_MIN_GAP_MINUTES: 60 },
      notifyAdmins: async (text) => void alerts.push(text),
      log: () => {},
    });

    await processChat(chat);
    expect(requests.map((request) => request.system === CONSOLIDATION_SYSTEM_PROMPT)).toEqual([false, true]);
    expect(alerts.some((alert) => alert.includes("Failed to process messages") && alert.includes("Next attempt in about 1 h"))).toBe(true);
    await processChat(chat);
    expect(requests).toHaveLength(2);

    await sql`UPDATE extraction_runs SET started_at = now() - interval '3 hours' WHERE chat_id = ${chat.id}`;
    await processChat(chat);
    expect(requests).toHaveLength(3);
    const retryAt = await nextExtractionRetryAt(sql, chat.id);
    expect(retryAt!.getTime() - Date.now()).toBeGreaterThan(1.9 * HOUR);
  });

  it("never lets the clean-up merge, drop or relabel a hidden fact", async () => {
    const chat = await newChat("Hidden facts");
    const owner = await person(chat.id, "Private person");
    const hiddenSwitch = await fact(chat.id, owner.id, "interest", "Nintendo Switch", "hidden");
    const games = await fact(chat.id, owner.id, "interest", "Nintendo games");
    const hiddenRust = await fact(chat.id, owner.id, "stack", "Rust", "hidden");
    const hiddenGpt = await fact(chat.id, owner.id, "stack", "ChatGPT", "hidden");
    await fact(chat.id, owner.id, "stack", "Codex CLI");
    const hiddenCombined = await fact(chat.id, owner.id, "stack", "Vercel, Scaleway", "hidden");

    const input = await loadConsolidationInput(sql, chat.id);
    expect(input.facts.map((item) => item.status)).not.toContain("hidden");
    await applyConsolidation(sql, input, { fact_merges: [{ fact_ids: [hiddenSwitch, games], value: "Nintendo" }], fact_drops: [{ fact_id: hiddenRust }], project_merges: [], project_updates: [] });
    expect(await mergeFacts(sql, [hiddenSwitch, games], "Nintendo Switch", "llm")).toBe(false);
    expect(await dropFact(sql, hiddenRust, "llm")).toBe(false);
    await normalizeStacks(sql, chat.id);

    const rows = new Map((await sql<{ id: number; value: string; status: string }[]>`SELECT id, value, status FROM facts WHERE user_id = ${owner.id}`).map((row) => [row.id, row]));
    for (const id of [hiddenSwitch, hiddenRust, hiddenGpt, hiddenCombined]) expect(rows.get(id)?.status).toBe("hidden");
    expect(rows.get(hiddenCombined)?.value).toBe("Vercel, Scaleway");
    expect((await visibleFacts(sql, chat.id, owner.id)).map((item) => item.value).sort()).toEqual(["GPT / Codex", "Nintendo"]);
    expect(await proposeFact(sql, { chatId: chat.id, userId: owner.id, kind: "stack", value: "Rust", confidence: 0.9, sourceMsgIds: [1], source: "llm" })).toBe("skipped_existing");
  });

  it("does not write back a fact the person removed as wrong, reworded or merged", async () => {
    const chat = await newChat("Rejections");
    const owner = await person(chat.id, "Picky person");
    const base = { chatId: chat.id, userId: owner.id, confidence: 0.9, sourceMsgIds: [1], source: "llm" as const };
    await proposeFact(sql, { ...base, kind: "role", value: "designer" });
    const [designer] = await visibleFacts(sql, chat.id, owner.id);
    await rejectFact(sql, designer!.id, owner.id, "user");
    await proposeFact(sql, { ...base, kind: "role", value: "frontend developer" });
    const [developer] = await visibleFacts(sql, chat.id, owner.id);
    expect(await rewriteFact(sql, developer!.id, "designer", [2], "llm")).toBe(false);
    expect(await mergeFacts(sql, [developer!.id], "Designer", "llm")).toBe(false);
    expect((await visibleFacts(sql, chat.id, owner.id)).map((item) => item.value)).toEqual(["frontend developer"]);

    await proposeFact(sql, { ...base, kind: "stack", value: "ChatGPT" });
    const chatGpt = (await visibleFacts(sql, chat.id, owner.id)).find((item) => item.kind === "stack")!;
    await rejectFact(sql, chatGpt.id, owner.id, "user");
    await fact(chat.id, owner.id, "stack", "Codex");
    await normalizeStacks(sql, chat.id);
    expect((await visibleFacts(sql, chat.id, owner.id)).filter((item) => item.kind === "stack").map((item) => item.value)).toEqual(["Codex"]);
  });

  it("lets an outdated copy of the new wording give way, and keeps a hidden one hidden", async () => {
    const chat = await newChat("Twins");
    const owner = await person(chat.id, "Busy person");
    await fact(chat.id, owner.id, "role", "backend developer", "deprecated");
    const senior = await fact(chat.id, owner.id, "role", "senior backend developer");
    expect(await rewriteFact(sql, senior, "backend developer", [5], "llm")).toBe(true);
    const roles = await sql<{ id: number; value: string; status: string }[]>`SELECT id, value, status FROM facts WHERE user_id = ${owner.id} AND kind = 'role'`;
    expect(roles).toEqual([{ id: senior, value: "backend developer", status: "auto" }]);

    const openings = await fact(chat.id, owner.id, "interest", "chess openings");
    const blitz = await fact(chat.id, owner.id, "interest", "blitz chess");
    await fact(chat.id, owner.id, "interest", "chess", "deprecated");
    expect(await mergeFacts(sql, [openings, blitz], "chess", "llm")).toBe(true);
    const interests = await sql<{ value: string; status: string }[]>`SELECT value, status FROM facts WHERE user_id = ${owner.id} AND kind = 'interest'`;
    expect(interests).toEqual([{ value: "chess", status: "auto" }]);

    const rustProgramming = await fact(chat.id, owner.id, "stack", "Rust programming");
    const hiddenRust = await fact(chat.id, owner.id, "stack", "Rust", "hidden");
    expect(await rewriteFact(sql, rustProgramming, "Rust", [6], "llm")).toBe(false);
    const stack = new Map((await sql<{ id: number; status: string }[]>`SELECT id, status FROM facts WHERE user_id = ${owner.id} AND kind = 'stack'`).map((row) => [row.id, row.status]));
    expect(stack).toEqual(new Map([[rustProgramming, "auto"], [hiddenRust, "hidden"]]));
  });

  it("restores a hidden fact with the status it had, so the person's own stays theirs", async () => {
    const chat = await newChat("Restore");
    const owner = await person(chat.id, "Careful person");
    await proposeFact(sql, { chatId: chat.id, userId: owner.id, kind: "expertise", value: "Unity shaders", confidence: 1, sourceMsgIds: [], source: "user", actorUserId: owner.id });
    await proposeFact(sql, { chatId: chat.id, userId: owner.id, kind: "interest", value: "e-ink readers", confidence: 0.9, sourceMsgIds: [1], source: "llm" });
    const facts = await visibleFacts(sql, chat.id, owner.id);
    const own = facts.find((item) => item.status === "manual")!;
    const auto = facts.find((item) => item.status === "auto")!;
    for (const item of [own, auto]) {
      expect(await setFactHidden(sql, item.id, true, owner.id, "user")).toBe(true);
      expect(await setFactHidden(sql, item.id, false, owner.id, "user")).toBe(true);
    }
    const statuses = new Map((await sql<{ id: number; status: string }[]>`SELECT id, status FROM facts WHERE user_id = ${owner.id}`).map((row) => [row.id, row.status]));
    expect(statuses.get(own.id)).toBe("manual");
    expect(statuses.get(auto.id)).toBe("auto");
    expect(await dropFact(sql, own.id, "llm")).toBe(false);

    // Hidden by an earlier version that did not record the status: a fact the person added is still theirs.
    await sql`UPDATE facts SET status = 'hidden' WHERE id = ${own.id}`;
    await sql`INSERT INTO change_log (entity, entity_id, op, source, actor_user_id) VALUES ('fact', ${own.id}, 'hide', 'user', ${owner.id})`;
    await setFactHidden(sql, own.id, false, owner.id, "user");
    expect((await sql<{ status: string }[]>`SELECT status FROM facts WHERE id = ${own.id}`)[0]!.status).toBe("manual");
  });

  it("catch-up in a quiet chat keeps everything since the reader's last message", async () => {
    const chat = await newChat("Quiet chat");
    const reader = await person(chat.id, "Reader");
    const writer = await person(chat.id, "Writer");
    await message(chat.id, 1, reader.id, "See you all next week", new Date(Date.now() - 3 * DAY));
    for (let msgId = 2; msgId <= 16; msgId += 1) await message(chat.id, msgId, writer.id, `Update ${msgId}`, new Date(Date.now() - 2 * DAY));
    await sql`
      INSERT INTO chronicle (chat_id, run_id, period_from, period_to, title, summary, importance, msg_ids)
      VALUES (${chat.id}, 0, now() - interval '2 days', now() - interval '2 days', 'The event of the week', 'Big news.', 5, '{2}')`;
    const data = await catchupFor(sql, chat.id, (await getPerson(sql, chat.id, reader.id))!);
    expect(data.from.getTime()).toBeLessThan(Date.now() - 2.5 * DAY);
    expect(data.totalMessages).toBe(15);
    expect(data.entries.map((entry) => entry.title)).toEqual(["The event of the week"]);
  });

  it("records nothing about a member who opted out, even while the model was answering", async () => {
    const chat = await newChat("Opt-outs");
    const author = await person(chat.id, "Maker");
    const quiet = await person(chat.id, "Quiet fan");
    await project(chat.id, "habit", "Habit", [author.id]);
    await message(chat.id, 1, quiet.id, "Installed Habit, I use it every day now");
    await message(chat.id, 2, author.id, "Habit 1.1 is out, and I'm starting Pulse with Quiet fan");
    const users = await peopleOfChat(sql, chat.id);
    const batch = await sql<StoredMessage[]>`SELECT * FROM messages WHERE chat_id = ${chat.id} ORDER BY msg_id`;
    const data: BatchData = { chatId: chat.id, batch, context: [], users, facts: [], projects: [{ slug: "habit", name: "Habit", status: "in_progress", authors: [`u${author.id}`] }] };
    // They opt out after the batch was loaded.
    await sql`UPDATE members SET opted_out = true WHERE chat_id = ${chat.id} AND user_id = ${quiet.id}`;
    const stats = await applyExtraction(sql, await newRun(chat.id), data, {
      ...EMPTY_EXTRACTION,
      projects: [{ slug: "pulse", name: "Pulse", tagline: null, status: null, stack: [], repo: null, site: null, authors: [`u${author.id}`, `u${quiet.id}`], confidence: 0.9, source_msg_ids: [2] }],
      project_signals: [{ project: "habit", person: `u${quiet.id}`, kind: "usage", impact: 4, note: "Quiet fan uses Habit every day", source_msg_ids: [1] }],
      facts_add: [{ person: `u${quiet.id}`, kind: "tagline", value: "Habit power user", confidence: 0.9, source_msg_ids: [1] }],
    });
    expect(stats.signals).toBe(0);
    expect(stats.taglines).toBe(0);
    expect((await getPerson(sql, chat.id, quiet.id))!.tagline).toBeNull();
    const authors = await sql<{ user_id: number }[]>`SELECT pm.user_id FROM project_members pm JOIN projects p ON p.id = pm.project_id WHERE p.chat_id = ${chat.id} AND p.slug = 'pulse'`;
    expect(authors.map((row) => row.user_id)).toEqual([author.id]);
  });

  it("marks a fact outdated when the chronicler updates it to null, and rewrites it otherwise", async () => {
    const chat = await newChat("Outdated facts");
    const anna = await person(chat.id, "Anna");
    const tool = await fact(chat.id, anna.id, "stack", "Codex");
    const role = await fact(chat.id, anna.id, "role", "frontend developer");
    await message(chat.id, 1, anna.id, "Switched from Codex to Claude, and I do backend now");
    const data: BatchData = {
      chatId: chat.id,
      batch: await sql<StoredMessage[]>`SELECT * FROM messages WHERE chat_id = ${chat.id} ORDER BY msg_id`,
      context: [],
      users: await peopleOfChat(sql, chat.id),
      facts: await visibleFacts(sql, chat.id, anna.id),
      projects: [],
    };
    const stats = await applyExtraction(sql, await newRun(chat.id), data, {
      ...EMPTY_EXTRACTION,
      facts_update: [
        { fact_id: tool, value: null, source_msg_ids: [1] },
        { fact_id: role, value: "backend developer", source_msg_ids: [1] },
      ],
    });
    expect(stats).toMatchObject({ factsOutdated: 1, factsUpdated: 1 });
    const rows = await sql<{ id: number; value: string; status: string }[]>`SELECT id, value, status FROM facts WHERE chat_id = ${chat.id} ORDER BY id`;
    expect(rows.find((row) => row.id === tool)).toMatchObject({ value: "Codex", status: "deprecated" });
    expect(rows.find((row) => row.id === role)).toMatchObject({ value: "backend developer" });
  });

  it("renames a project only on its author's or a bot owner's word, never a joke by someone else", async () => {
    const chat = await newChat("Renames");
    const maker = await person(chat.id, "Maya");
    const joker = await person(chat.id, "Joker");
    const owner = await person(chat.id, "Owner");
    const movieNight = await project(chat.id, "movie-night", "Movie night", [maker.id]);
    const harbor = await project(chat.id, "harbor", "Harbor", [maker.id]);
    const streamer = await project(chat.id, "streamer", "Streamer", [maker.id]);
    const fixed = await project(chat.id, "fixed", "Fixed name", [maker.id]);
    await sql`UPDATE projects SET manual_fields = '{name}' WHERE id = ${fixed}`;
    await message(chat.id, 1, maker.id, "Мой проект теперь называется Tandem");
    await message(chat.id, 2, joker.id, "Переименуйте Harbor в Помойку");
    await message(chat.id, 3, owner.id, "Инфа: проект называется Nova");
    await message(chat.id, 4, maker.id, "А Fixed name теперь Something");
    const batch = await sql<StoredMessage[]>`SELECT * FROM messages WHERE chat_id = ${chat.id} ORDER BY msg_id`;
    const data: BatchData = {
      chatId: chat.id,
      batch,
      context: [],
      users: await peopleOfChat(sql, chat.id),
      facts: [],
      projects: [],
      ownerTgIds: [owner.tg_id!],
    };
    expect(buildExtractionPrompt(data)).toContain(`u${owner.id} | Owner | bot owner`);
    await applyExtraction(sql, await newRun(chat.id), data, {
      ...EMPTY_EXTRACTION,
      project_renames: [
        { project: "movie-night", name: "Tandem", source_msg_ids: [1] },
        { project: "harbor", name: "Помойка", source_msg_ids: [2] },
        { project: "streamer", name: "Nova", source_msg_ids: [3] },
        { project: "fixed", name: "Something", source_msg_ids: [4] },
      ],
      topics: [{ title: "Tandem got its name", summary: "Maya named the project.", kind: "project", importance: 3, project: "tandem", msg_ids: [1] }],
    });
    const names = new Map((await sql<{ id: number; name: string; slug: string }[]>`SELECT id, name, slug FROM projects WHERE chat_id = ${chat.id}`).map((row) => [row.id, row]));
    expect(names.get(movieNight)).toMatchObject({ name: "Tandem", slug: "tandem" });
    expect(names.get(harbor)).toMatchObject({ name: "Harbor", slug: "harbor" });
    expect(names.get(streamer)).toMatchObject({ name: "Nova", slug: "nova" });
    expect(names.get(fixed)).toMatchObject({ name: "Fixed name" });
    const [topic] = await sql<{ project_id: number | null }[]>`SELECT project_id FROM chronicle WHERE chat_id = ${chat.id}`;
    expect(topic!.project_id).toBe(movieNight);
  });

  it("applies changes to a catalog project even when the model names no authors", async () => {
    const chat = await newChat("Catalog updates");
    const author = await person(chat.id, "Builder");
    await project(chat.id, "atlas", "Atlas", [author.id]);
    await message(chat.id, 1, author.id, "Atlas is live at atlas.example.app");
    const batch = await sql<StoredMessage[]>`SELECT * FROM messages WHERE chat_id = ${chat.id}`;
    const data: BatchData = { chatId: chat.id, batch, context: [], users: await peopleOfChat(sql, chat.id), facts: [], projects: [{ slug: "atlas", name: "Atlas", status: "in_progress", authors: [`u${author.id}`] }] };
    const item = { tagline: null, stack: [], repo: null, confidence: 0.9, source_msg_ids: [1], authors: [] };
    await applyExtraction(sql, await newRun(chat.id), data, {
      ...EMPTY_EXTRACTION,
      projects: [
        { ...item, slug: "atlas", name: "Atlas", status: "launched", site: "https://atlas.example.app" },
        { ...item, slug: "nobody-s", name: "Nobody's", status: null, site: null },
      ],
    });
    const rows = await sql<{ slug: string; status: string; links: { site?: string } }[]>`SELECT slug, status, links FROM projects WHERE chat_id = ${chat.id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("launched");
    expect(rows[0]!.links.site).toBe("https://atlas.example.app");
  });

  it("applies a batch all at once: a failure leaves nothing behind and the messages pending", async () => {
    const chat = await newChat("Atomic batches");
    const author = await person(chat.id, "Author");
    const fan = await person(chat.id, "Fan");
    await project(chat.id, "thing", "Thing", [author.id]);
    await message(chat.id, 1, fan.id, "Tried Thing, it is great");
    await message(chat.id, 2, fan.id, "Also, I write Rust for a living");
    const batch = await sql<StoredMessage[]>`SELECT * FROM messages WHERE chat_id = ${chat.id} ORDER BY msg_id`;
    const data: BatchData = { chatId: chat.id, batch, context: [], users: await peopleOfChat(sql, chat.id), facts: [], projects: [] };
    const broken = {
      ...EMPTY_EXTRACTION,
      topics: [{ title: "Fan tried Thing", summary: "Fan liked Thing.", kind: "project", importance: 3, project: "thing", msg_ids: [1] }],
      facts_add: [{ person: `u${fan.id}`, kind: "stack", value: "Rust", confidence: 0.95, source_msg_ids: [2] }],
      // Off the database's list: the insert fails after the topic and the fact were written.
      project_signals: [{ project: "thing", person: `u${fan.id}`, kind: "hype", impact: 3, note: "Fan is excited", source_msg_ids: [1] }],
    } as unknown as ExtractionResult;
    await expect(applyExtraction(sql, await newRun(chat.id), data, broken)).rejects.toThrow();
    expect((await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM chronicle WHERE chat_id = ${chat.id}`)[0]!.count).toBe(0);
    expect(await visibleFacts(sql, chat.id, fan.id)).toEqual([]);
    expect(await pendingCount(chat.id)).toBe(2);
  });

  it("keeps one role on a card: another one beside it is left out, and the same one reinforces it", async () => {
    const chat = await newChat("One role");
    const dev = await person(chat.id, "Dev");
    await message(chat.id, 1, dev.id, "I build Telegram bots for small shops, and mobile games on weekends");
    await proposeFact(sql, { chatId: chat.id, userId: dev.id, kind: "role", value: "backend developer", confidence: 0.7, sourceMsgIds: [1], source: "llm" });
    const batch = await sql<StoredMessage[]>`SELECT * FROM messages WHERE chat_id = ${chat.id} ORDER BY msg_id`;
    const data: BatchData = { chatId: chat.id, batch, context: [], users: await peopleOfChat(sql, chat.id), facts: await visibleFacts(sql, chat.id, dev.id), projects: [] };
    const roles = {
      ...EMPTY_EXTRACTION,
      facts_add: [
        { person: `u${dev.id}`, kind: "role", value: "makes mobile games", confidence: 0.8, source_msg_ids: [1] },
        { person: `u${dev.id}`, kind: "role", value: "backend developer", confidence: 0.9, source_msg_ids: [1] },
      ],
    } as unknown as ExtractionResult;
    await applyExtraction(sql, await newRun(chat.id), data, roles);
    const kept = (await visibleFacts(sql, chat.id, dev.id)).filter((fact) => fact.kind === "role");
    expect(kept.map((fact) => fact.value)).toEqual(["backend developer"]);
    expect(kept[0]!.confidence).toBeGreaterThan(0.7);
  });

  it("attach merges an imported project into the chat's project with the same slug", async () => {
    const chat = await newChat("Attach projects");
    const anna = await person(chat.id, "Anna");
    await sql`INSERT INTO members (chat_id, user_id) VALUES (${LEGACY_CHAT_ID}, ${anna.id})`;
    const bob = await person(LEGACY_CHAT_ID, "Bob");
    const dana = await person(LEGACY_CHAT_ID, "Dana");
    // The chronicler made this one in the chat after approval, before the owner attached the import.
    const own = await project(chat.id, "orbit", "Orbit", [anna.id]);
    const imported = await project(LEGACY_CHAT_ID, "orbit", "Orbit", [anna.id]);
    const lumen = await project(LEGACY_CHAT_ID, "lumen", "Lumen", [bob.id]);
    await sql`INSERT INTO project_members (project_id, user_id, role) VALUES (${imported}, ${dana.id}, 'design')`;
    await sql`INSERT INTO votes (project_id, user_id) VALUES (${imported}, ${bob.id})`;
    await sql`
      INSERT INTO project_signals (project_id, user_id, kind, impact, note, happened_at)
      VALUES (${imported}, ${bob.id}, 'usage', 4, 'Bob uses Orbit daily', now()), (${imported}, ${bob.id}, 'praise', 3, 'Bob likes Orbit', now())`;
    const [topic] = await sql<{ id: number }[]>`
      INSERT INTO chronicle (chat_id, run_id, period_from, period_to, title, summary, kind, project_id)
      VALUES (${LEGACY_CHAT_ID}, 0, now(), now(), 'Orbit 1.0 shipped', 'Anna shipped Orbit 1.0.', 'project', ${imported}) RETURNING id`;
    // Another chat's topic that an earlier version linked to the imported Lumen.
    const elsewhere = await newChat("Elsewhere");
    const [strayTopic] = await sql<{ id: number }[]>`
      INSERT INTO chronicle (chat_id, run_id, period_from, period_to, title, summary, kind, project_id)
      VALUES (${elsewhere.id}, 0, now(), now(), 'Lumen mentioned', 'Someone mentioned Lumen.', 'discussion', ${lumen}) RETURNING id`;

    const moved = await attachLegacyData(sql, chat.id);
    expect(moved).toMatchObject({ projects: 2, projectsMerged: 1, topics: 1 });
    expect((await sql<{ project_id: number | null }[]>`SELECT project_id FROM chronicle WHERE id = ${strayTopic!.id}`)[0]!.project_id).toBeNull();
    const [merged] = await sql<{ signals: number; votes: number; authors: string[] }[]>`
      SELECT (SELECT count(*)::int FROM project_signals WHERE project_id = ${own}) AS signals,
             (SELECT count(*)::int FROM votes WHERE project_id = ${own}) AS votes,
             (SELECT array_agg(user_id || ':' || coalesce(role, '-') ORDER BY user_id) FROM project_members WHERE project_id = ${own}) AS authors`;
    expect(merged).toEqual({ signals: 2, votes: 1, authors: [`${anna.id}:-`, `${dana.id}:design`] });
    expect((await sql<{ chat_id: number; project_id: number }[]>`SELECT chat_id, project_id FROM chronicle WHERE id = ${topic!.id}`)[0]).toEqual({ chat_id: chat.id, project_id: own });
    expect((await sql<{ chat_id: number }[]>`SELECT chat_id FROM projects WHERE id = ${lumen}`)[0]!.chat_id).toBe(chat.id);
    const [left] = await sql<{ count: number }[]>`
      SELECT (SELECT count(*) FROM projects WHERE chat_id = ${LEGACY_CHAT_ID}) + (SELECT count(*) FROM chronicle WHERE chat_id = ${LEGACY_CHAT_ID})
           + (SELECT count(*) FROM members WHERE chat_id = ${LEGACY_CHAT_ID}) AS count`;
    expect(Number(left!.count)).toBe(0);
  });

  it("attach keeps the person's own word, removals and opt-outs from both sides", async () => {
    const chat = await newChat("Attach cards");
    const anna = await person(chat.id, "Anna", "K.");
    const bob = await person(chat.id, "Bob", "K.");
    const quiet = await person(chat.id, "Quiet", "K.");
    await sql`
      INSERT INTO members (chat_id, user_id, tagline, tagline_manual) VALUES
        (${LEGACY_CHAT_ID}, ${anna.id}, 'Writes her own tagline', true),
        (${LEGACY_CHAT_ID}, ${bob.id}, 'Old automatic tagline', false),
        (${LEGACY_CHAT_ID}, ${quiet.id}, 'Imported tagline', false)`;
    await sql`UPDATE members SET tagline = 'New automatic tagline' WHERE chat_id = ${chat.id} AND user_id IN (${anna.id}, ${bob.id})`;
    await sql`UPDATE members SET opted_out = true WHERE chat_id = ${chat.id} AND user_id = ${quiet.id}`;

    await fact(chat.id, anna.id, "interest", "Nintendo");
    await fact(chat.id, anna.id, "expertise", "self-hosted VPN");
    await fact(chat.id, anna.id, "stack", "Go");
    await fact(LEGACY_CHAT_ID, anna.id, "interest", "Nintendo", "hidden");
    await fact(LEGACY_CHAT_ID, anna.id, "expertise", "self-hosted VPN", "manual");
    await fact(LEGACY_CHAT_ID, anna.id, "stack", "Kotlin");
    await fact(LEGACY_CHAT_ID, quiet.id, "interest", "chess");
    await sql`INSERT INTO rejected_facts (chat_id, user_id, kind, value_norm) VALUES (${chat.id}, ${anna.id}, 'stack', 'kotlin'), (${LEGACY_CHAT_ID}, ${anna.id}, 'stack', 'go')`;

    await message(LEGACY_CHAT_ID, 501, anna.id, "Imported message");
    await message(LEGACY_CHAT_ID, 502, anna.id, "Imported copy");
    await message(chat.id, 502, anna.id, "The chat's own copy");
    const quietPick = await project(LEGACY_CHAT_ID, "quiet-pick", "Quiet pick", [anna.id]);
    await sql`INSERT INTO project_signals (project_id, user_id, kind, impact, note, happened_at) VALUES (${quietPick}, ${quiet.id}, 'usage', 3, 'Quiet uses it', now())`;

    const moved = await attachLegacyData(sql, chat.id);
    expect(moved.messages).toBe(1);
    expect((await sql`SELECT 1 FROM project_signals WHERE user_id = ${quiet.id}`).length).toBe(0);
    const annaFacts = await sql<{ value: string; status: string }[]>`SELECT value, status FROM facts WHERE chat_id = ${chat.id} AND user_id = ${anna.id} ORDER BY value`;
    expect(annaFacts).toEqual([
      { value: "Nintendo", status: "hidden" },
      { value: "self-hosted VPN", status: "manual" },
    ]);
    expect((await sql`SELECT 1 FROM facts WHERE user_id = ${quiet.id}`).length).toBe(0);
    const members = new Map((await sql<{ user_id: number; tagline: string | null; tagline_manual: boolean }[]>`SELECT user_id, tagline, tagline_manual FROM members WHERE chat_id = ${chat.id}`).map((row) => [row.user_id, row]));
    expect(members.get(anna.id)).toMatchObject({ tagline: "Writes her own tagline", tagline_manual: true });
    expect(members.get(bob.id)).toMatchObject({ tagline: "New automatic tagline", tagline_manual: false });
    expect(members.get(quiet.id)).toMatchObject({ tagline: null, tagline_manual: false });
    expect((await sql<{ text: string }[]>`SELECT text FROM messages WHERE chat_id = ${chat.id} AND msg_id = 502`)[0]!.text).toBe("The chat's own copy");
    const [left] = await sql<{ count: number }[]>`
      SELECT (SELECT count(*) FROM messages WHERE chat_id = ${LEGACY_CHAT_ID}) + (SELECT count(*) FROM facts WHERE chat_id = ${LEGACY_CHAT_ID})
           + (SELECT count(*) FROM rejected_facts WHERE chat_id = ${LEGACY_CHAT_ID}) AS count`;
    expect(Number(left!.count)).toBe(0);
  });

  it("attach follows a merged-away duplicate to the project it went into", async () => {
    const chat = await newChat("Attach into a merged project");
    const anna = await person(chat.id, "Anna");
    const keeper = await project(chat.id, "beacon", "Beacon", [anna.id]);
    await project(chat.id, "beacon-app", "Beacon app", [anna.id]);
    await mergeProjects(sql, chat.id, "beacon", ["beacon-app"]);
    const imported = await project(LEGACY_CHAT_ID, "beacon-app", "Beacon app (imported)", [anna.id]);
    await sql`INSERT INTO project_signals (project_id, user_id, kind, impact, note, happened_at) VALUES (${imported}, ${anna.id}, 'milestone', 3, 'Beacon 2 shipped', now())`;
    const moved = await attachLegacyData(sql, chat.id);
    expect(moved.projectsMerged).toBe(1);
    expect((await sql<{ project_id: number }[]>`SELECT project_id FROM project_signals WHERE note = 'Beacon 2 shipped'`).map((row) => row.project_id)).toEqual([keeper]);
  });

  it("attach links an imported card to the account of a person who wrote before the import was attached", async () => {
    const chat = await newChat("Attach cards to accounts");
    const insertCard = async (name: string) => {
      const [card] = await sql<{ id: number }[]>`INSERT INTO users (display_name) VALUES (${name}) RETURNING id`;
      await sql`INSERT INTO members (chat_id, user_id) VALUES (${LEGACY_CHAT_ID}, ${card!.id})`;
      return card!.id;
    };
    const card = await insertCard("Erin Imported");
    await proposeFact(sql, { chatId: LEGACY_CHAT_ID, userId: card, kind: "stack", value: "Elixir", confidence: 0.9, sourceMsgIds: [1], source: "seed" });
    const twinCard = await insertCard("Twin Name");
    // Erin writes after approval: her card is not in the chat yet, so she gets an account of her own.
    const erin = await person(chat.id, "Erin", "Imported");
    expect(erin.id).not.toBe(card);
    // Two accounts share this name: which one the card belongs to is an owner's call.
    await person(chat.id, "Twin", "Name");
    await person(chat.id, "Twin", "Name");

    const moved = await attachLegacyData(sql, chat.id);
    expect(moved.cardsLinked).toBe(1);
    expect((await visibleFacts(sql, chat.id, erin.id)).map((item) => item.value)).toEqual(["Elixir"]);
    expect((await sql`SELECT 1 FROM users WHERE id = ${card}`).length).toBe(0);
    expect((await sql`SELECT 1 FROM users WHERE id = ${twinCard} AND tg_id IS NULL`).length).toBe(1);
  });

  // Last in the file: it runs the real scheduler, which goes through every approved chat.
  it("a scheduler stop waits for the call under way, then cancels it and records what it cost", async () => {
    const chat = await newChat("Scheduler stop");
    await sql`UPDATE chats SET status = 'left' WHERE id <> ${chat.id}`;
    const author = await person(chat.id, "Writer");
    await message(chat.id, 1, author.id, "A long day of release notes to chronicle");
    let callStarted!: () => void;
    const started = new Promise<void>((resolve) => (callStarted = resolve));
    const hanging = {
      messages: {
        stream(_params: unknown, options?: { signal?: AbortSignal }) {
          callStarted();
          return {
            currentMessage: { usage: { input_tokens: 20_000, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
            finalMessage: () => new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("Request was aborted.")))),
          };
        },
      },
    } as unknown as Anthropic;
    const alerts: string[] = [];
    const stop = startExtractionScheduler({
      sql,
      anthropic: hanging,
      config: { EXTRACTION_MODEL: MODEL, MONTHLY_LLM_BUDGET_USD: 500, CHAT_MONTHLY_BUDGET_USD: 50, EXTRACTION_INTERVAL_HOURS: 6, EXTRACTION_PASS_MESSAGES: 200, EXTRACTION_MIN_GAP_MINUTES: 60 },
      notifyAdmins: async (text) => void alerts.push(text),
      log: () => {},
      checkEveryMs: 60_000,
    });
    await started;
    await stop(50);
    expect(await usageRows(chat.id)).toBe(1);
    const [run] = await sql<{ status: string; error: string }[]>`SELECT status, error FROM extraction_runs WHERE chat_id = ${chat.id}`;
    expect(run).toEqual({ status: "failed", error: INTERRUPTED_PASS_ERROR });
    expect(alerts).toEqual([]);
  });
});
