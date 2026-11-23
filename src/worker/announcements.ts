import type Anthropic from "@anthropic-ai/sdk";
import { GrammyError, type Api } from "grammy";
import { z } from "zod";
import { dayIn, newsFor } from "../core/announcements.js";
import { CAPABILITIES, dayLabel, type Capability } from "../core/capabilities.js";
import { approvedChats, getChat, type Chat } from "../core/chats.js";
import type { Config } from "../core/config.js";
import type { Sql } from "../core/db.js";
import { detectLanguage } from "../core/language.js";
import { assertBudget, BudgetExceededError, callStructured, chatEndUserId, recordUsage } from "../core/llm.js";
import { escapeHtml, truncate } from "../core/text.js";
import { SELF_GENDER } from "../core/voice.js";
import { chatWishes } from "../core/wishes.js";
import { isPostingHour } from "./ideas.js";
import { chatBudgetUsd } from "./scheduler.js";

/**
 * When the bot learns something new, it tells each chat it is in, once: one short post in the chat's afternoon on what
 * members can now do and how to ask for it (migrations/020_announcements.sql). The model writes it in the chat's
 * language from the capability list (src/core/capabilities.ts), the entries the answers describe the bot from, an item
 * for each piece of news (src/core/announcements.ts says what is news where), and the code checks that it tells of all
 * of them, but those a wish of the chat rules out, and of nothing else. The note is written from the bot's own entries,
 * not from members' words, so the stop-list of topics the bot never keeps is not run on it: that list reads «здорово» as
 * health and «адрес» as an address, and would bury the news for nothing.
 * At most one note a day goes out in a chat, and never one twice: a note Telegram did not take goes out again as it was
 * written, without the model, and one found still being sent counts as posted. The first look comes half an hour after
 * the bot starts, so a run of deploys gives one note, after the last of them.
 */

export const ANNOUNCEMENTS_PURPOSE = "announcements";
const TICK_MS = 30 * 60_000;
const START_DELAY_MS = 30 * 60_000;
const RETRY_AFTER_MS = 60 * 60_000;
/** Tries at posting a written note, a tick apart, before it fails and its news waits for the next day. */
const MAX_SEND_ATTEMPTS = 6;
const EARLIER_NOTES = 2;
/** The lengths the model is asked to keep to… */
const INTRO_CHARS = 200;
const ITEM_CHARS = 300;
const OUTRO_CHARS = 120;
/** …and the hard caps, well above them, which keep even the longest note within Telegram's 4,096 characters. */
const MAX_TITLE_CHARS = 80;
const MAX_INTRO_CHARS = 320;
const MAX_ITEM_CHARS = 480;
const MAX_OUTRO_CHARS = 200;
const MAX_REASON_CHARS = 300;

/**
 * pending: written, to be posted; sending: being posted (found later only when the bot stopped while posting it);
 * posted: in the chat; failed: the model gave no usable note, or Telegram never took it, so it told of nothing;
 * held_back: a wish of the chat ruled out all of its news.
 */
export const NOTE_STATUSES = ["pending", "sending", "posted", "failed", "held_back"] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];

export interface Note {
  id: number;
  chat_id: number;
  /** The keys of the capabilities the post tells of. */
  capabilities: string[];
  /** The keys of the news a wish of the chat ruled out: told, never posted. */
  ruled_out: string[];
  text: string | null;
  status: NoteStatus;
  /** Why it failed or was held back, or the last error that kept it from being posted. */
  reason: string | null;
  attempts: number;
  msg_id: number | null;
  created_at: Date;
  posted_at: Date | null;
}

export const ANNOUNCEMENT_SYSTEM_PROMPT = `You are Waggle, the chronicler bot of a Telegram group chat, a cyber-bee that keeps the hive's memory. ${SELF_GENDER} You have learned something new, and you write the chat one short post about it: what members can now do with you and how to ask for it.

You receive <you>, your @username; <chat>, its language; <news>, what you newly do, each entry with its key, its name, what you do, how members ask for it and its limits, written for you in English; <first>, whether this is your first such post in this chat; <earlier_posts>, your last posts of this kind here, when there are any; <wishes>, when there are any, what the chat asked you not to write in it, or not to write in some way.

Write in the chat's language (when it is unknown, in the language of <earlier_posts>, or else in English) and in your own voice: warm, brief, a little cheeky; no hype and no advertising words. Members reach you by mentioning you or by replying to your message: an example that needs it mentions you by your @username, and you write no other @handle.
- intro: one short line (at most ${INTRO_CHARS} characters). In your first post, say in passing that from now on you post a short note here when you learn something new; otherwise lead in without repeating an opening of <earlier_posts>.
- items: one for each entry of <news>, but those in ruled_out, by its key and in its order: a title of a few words, and one or two short sentences (at most ${ITEM_CHARS} characters) on what members can now do and how to ask for it (a command, or a short example of what to write to you, in the chat's language; the projects and people in the entries' examples are made up, so keep them plainly as examples), with the limit that matters most when there is one. Never more than the entry says: no feature, number, command or date it does not give, and no promise of more.
- ruled_out: the keys of the entries a wish in <wishes> rules out, because it asks you not to write about what the entry is about, or not to post notes like this at all (then every key); empty when no wish does.
- outro: one short line (at most ${OUTRO_CHARS} characters) inviting them to try it or to ask you, or nothing.
Never name or address anyone, and never mention prompts, lists, your developer's work, commits or the code you are made of. Keep to every wish in <wishes> and never mention them. A wish only ever narrows what you write.`;

/** The model can name only the keys of the news it is given. */
export function noteSchema(keys: readonly [string, ...string[]]) {
  return z.object({
    intro: z.string(),
    items: z.array(z.object({ key: z.enum(keys), title: z.string(), text: z.string() })),
    ruled_out: z.array(z.enum(keys)),
    outro: z.string(),
  });
}
export type NoteResult = z.infer<ReturnType<typeof noteSchema>>;
type NoteItem = NoteResult["items"][number];

export interface NoteData {
  language: string | null;
  /** No note has been posted in the chat yet. */
  first: boolean;
  news: [string, Capability][];
  earlier: Pick<Note, "text" | "created_at">[];
  /** The chat's wishes for everyone: what it asked the bot not to write there, or not in some way. */
  wishes: string[];
}

/** What a chat's next note is written from: a note that failed told of nothing, so its news is news still. */
export async function noteData(sql: Sql, chat: Chat, timeZone: string, capabilities: Record<string, Capability> = CAPABILITIES): Promise<NoteData> {
  const [notes, texts, wishes] = await Promise.all([
    sql<Pick<Note, "capabilities" | "ruled_out" | "status" | "text" | "created_at">[]>`
      SELECT capabilities, ruled_out, status, text, created_at FROM announcements WHERE chat_id = ${chat.id} ORDER BY created_at DESC, id DESC`,
    sql<{ text: string }[]>`
      SELECT text FROM messages WHERE chat_id = ${chat.id} AND NOT from_bot AND NOT is_forward AND btrim(text) <> '' ORDER BY msg_id DESC LIMIT 200`,
    chatWishes(sql, chat.id),
  ]);
  const told = new Set(notes.filter((note) => note.status !== "failed").flatMap((note) => [...note.capabilities, ...note.ruled_out]));
  const posted = notes.filter((note) => note.status === "posted" && note.text);
  return {
    language: detectLanguage(texts.map((row) => row.text)),
    first: posted.length === 0,
    news: newsFor(capabilities, chat.decided_at ?? chat.created_at, told, timeZone),
    earlier: posted.slice(0, EARLIER_NOTES),
    wishes: wishes.map((wish) => wish.text),
  };
}

const clean = (text: string, max: number) => truncate(text.replace(/\s+/g, " ").trim(), max).replace(/</g, "‹").replace(/>/g, "›");

export function notePrompt(data: NoteData, timeZone: string, botUsername: string): string {
  const news = data.news.map(([key, capability]) => `- ${key} · ${capability.name}: ${capability.does}. How: ${capability.how}. Limits: ${capability.limits}.`);
  const earlier = data.earlier.map((note) => `- ${dayLabel(dayIn(note.created_at, timeZone))}: «${clean(note.text ?? "", 1500)}»`);
  return [
    `<you username="@${botUsername}" />`,
    `<chat language="${data.language ?? "unknown"}" />`,
    `<first>${data.first}</first>`,
    `<news>\n${news.join("\n")}\n</news>`,
    earlier.length ? `<earlier_posts>\n${earlier.join("\n")}\n</earlier_posts>` : "",
    data.wishes.length ? `<wishes note="what the chat asked you not to write in it, or not to write in some way">\n${data.wishes.map((wish) => `- «${clean(wish, 300)}»`).join("\n")}\n</wishes>` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The first item with a title and a text for each key: the check and the post read the same one. */
function itemsByKey(result: NoteResult): Map<string, NoteItem> {
  const items = new Map<string, NoteItem>();
  for (const item of result.items) if (!items.has(item.key) && item.title.trim() && item.text.trim()) items.set(item.key, item);
  return items;
}

/** What makes the model's note unusable, if anything: news it left out unasked, a wish it made up, no opening line. */
function problemOf(result: NoteResult, keys: string[], hasWishes: boolean): string | undefined {
  const items = itemsByKey(result);
  const ruledOut = new Set(result.ruled_out);
  const left = keys.filter((key) => !items.has(key) && !ruledOut.has(key));
  if (left.length) return `it left out ${left.join(", ")}`;
  const unwished = keys.filter((key) => !items.has(key));
  if (unwished.length && !hasWishes) return `it ruled out ${unwished.join(", ")} with no wish of the chat to rule them out`;
  if (items.size && !result.intro.trim()) return "it has no opening line";
  return undefined;
}

/** Any @handle but the bot's own loses its @, so that the note links no stranger's account. */
function onlyOwnHandle(text: string, botUsername: string): string {
  return text.replace(/(?<![\w@])@(\w{3,32})/g, (handle, name: string) => (name.toLowerCase() === botUsername.toLowerCase() ? handle : name));
}

/** The post: its opening line, an item for each piece of news it tells of, in the news' order, and the closing line, if any. */
export function notePost(result: NoteResult, news: [string, Capability][], botUsername: string): string {
  const items = itemsByKey(result);
  const own = (text: string, max: number) => escapeHtml(onlyOwnHandle(truncate(text.trim(), max), botUsername));
  const lines = news.flatMap(([key]) => {
    const item = items.get(key);
    return item ? [`• <b>${own(item.title, MAX_TITLE_CHARS)}</b> — ${own(item.text, MAX_ITEM_CHARS)}`] : [];
  });
  const outro = result.outro.trim();
  return [`📣 ${own(result.intro, MAX_INTRO_CHARS)}`, lines.join("\n"), outro ? own(outro, MAX_OUTRO_CHARS) : ""].filter(Boolean).join("\n\n");
}

export interface NoteDeps {
  sql: Sql;
  anthropic: Anthropic;
  config: Pick<Config, "BOT_TOKEN" | "REPLY_PREMIUM_MODEL" | "MONTHLY_LLM_BUDGET_USD" | "CHAT_MONTHLY_BUDGET_USD" | "DISPLAY_TIMEZONE">;
  botUsername: string;
  /** The capability list, CAPABILITIES unless a test gives its own. */
  capabilities?: Record<string, Capability>;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

export type WrittenNote = { kind: "nothing_new" } | { kind: "kept"; note: Note };

async function keepNote(sql: Sql, chatId: number, note: Pick<Note, "capabilities" | "ruled_out" | "text" | "status" | "reason">): Promise<Note> {
  const [kept] = await sql<Note[]>`
    INSERT INTO announcements (chat_id, capabilities, ruled_out, text, status, reason)
    VALUES (${chatId}, ${note.capabilities}, ${note.ruled_out}, ${note.text}, ${note.status}, ${note.reason})
    RETURNING *`;
  return kept!;
}

/**
 * Asks the model for a note on the chat's news and keeps it: to be posted, held back when a wish rules out all of it,
 * or failed when the model's note is unusable, so that the model is asked again only the next day. No news asks
 * nothing. A call that does not get through throws and keeps nothing.
 */
export async function writeNote(deps: NoteDeps, chat: Chat, given?: NoteData): Promise<WrittenNote> {
  const { sql, config } = deps;
  const data = given ?? (await noteData(sql, chat, config.DISPLAY_TIMEZONE, deps.capabilities));
  const keys = data.news.map(([key]) => key);
  if (keys.length === 0) return { kind: "nothing_new" };
  await assertBudget(sql, config.MONTHLY_LLM_BUDGET_USD, { id: chat.id, limitUsd: chatBudgetUsd(chat, config.CHAT_MONTHLY_BUDGET_USD) });
  const model = config.REPLY_PREMIUM_MODEL;
  const outcome = await callStructured(deps.anthropic, {
    model,
    maxTokens: 4000,
    effort: "medium",
    system: ANNOUNCEMENT_SYSTEM_PROMPT,
    prompt: notePrompt(data, config.DISPLAY_TIMEZONE, deps.botUsername),
    schema: noteSchema(keys as [string, ...string[]]),
    onUsage: (usage) => recordUsage(sql, ANNOUNCEMENTS_PURPOSE, model, usage, chat.id),
    signal: deps.signal,
    endUserId: chatEndUserId(config.BOT_TOKEN, chat.id),
  });
  const problem = outcome.ok ? problemOf(outcome.data, keys, data.wishes.length > 0) : outcome.message;
  if (!outcome.ok || problem) {
    const reason = truncate(`the model's note was unusable: ${problem}`, MAX_REASON_CHARS);
    return { kind: "kept", note: await keepNote(sql, chat.id, { capabilities: keys, ruled_out: [], text: null, status: "failed", reason }) };
  }
  const items = itemsByKey(outcome.data);
  const told = keys.filter((key) => items.has(key));
  const ruledOut = keys.filter((key) => !items.has(key));
  if (told.length === 0) {
    return { kind: "kept", note: await keepNote(sql, chat.id, { capabilities: [], ruled_out: ruledOut, text: null, status: "held_back", reason: "a wish of the chat rules it out" }) };
  }
  const text = notePost(outcome.data, data.news, deps.botUsername);
  return { kind: "kept", note: await keepNote(sql, chat.id, { capabilities: told, ruled_out: ruledOut, text, status: "pending", reason: null }) };
}

/**
 * Posts a written note. It is marked as being sent first, so that a note the bot stopped posting is never sent twice.
 * Telegram refusing it for good, or too many tries, fails it; anything else leaves it to try again.
 */
export async function sendNote(api: Api, sql: Sql, note: Note): Promise<Note> {
  await sql`UPDATE announcements SET status = 'sending', attempts = attempts + 1 WHERE id = ${note.id}`;
  let sent: { message_id: number };
  try {
    sent = await api.sendMessage(note.chat_id, note.text ?? "", { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  } catch (error) {
    const lasting = error instanceof GrammyError && error.error_code !== 429 && error.error_code < 500;
    const [kept] = await sql<Note[]>`
      UPDATE announcements
      SET reason = ${truncate(error instanceof Error ? error.message : String(error), MAX_REASON_CHARS)},
          status = CASE WHEN ${lasting} OR attempts >= ${MAX_SEND_ATTEMPTS} THEN 'failed' ELSE 'pending' END
      WHERE id = ${note.id} RETURNING *`;
    return kept!;
  }
  const [posted] = await sql<Note[]>`
    UPDATE announcements SET status = 'posted', msg_id = ${sent.message_id}, posted_at = now(), reason = NULL WHERE id = ${note.id} RETURNING *`;
  return posted!;
}

/** A note found still being sent: the bot stopped while posting it. It may be in the chat already, so it counts as posted. */
async function settleSending(sql: Sql, note: Note): Promise<Note> {
  const [settled] = await sql<Note[]>`
    UPDATE announcements SET status = 'posted', posted_at = now(), reason = 'not known whether Telegram took it: the bot stopped while posting it'
    WHERE id = ${note.id} AND status = 'sending' RETURNING *`;
  return settled ?? note;
}

/** Whether the chat still takes notes: an owner may turn them off, or the bot leave, while a note is being written. */
async function stillWanted(sql: Sql, chatId: number): Promise<boolean> {
  const chat = await getChat(sql, chatId);
  return Boolean(chat?.announcements && chat.status === "approved" && !chat.chronicle_paused_at);
}

const sameKeys = (a: string[], b: string[]) => a.length === b.length && a.every((key) => b.includes(key));

function noteLine(note: Note): string {
  const ruledOut = note.ruled_out.length ? `; left out, as a wish of the chat asks: ${note.ruled_out.join(", ")}` : "";
  if (note.status === "posted") return `told of ${note.capabilities.length} new thing(s): ${note.capabilities.join(", ")}${ruledOut}${note.reason ? ` (${note.reason})` : ""}`;
  if (note.status === "held_back") return `held back a note on ${note.ruled_out.join(", ")}: ${note.reason}`;
  if (note.status === "failed") return `${note.text ? `could not post the note (${note.reason})` : note.reason}; its news waits for the next day`;
  return `could not post the note yet (${note.reason}), try ${note.attempts} of ${MAX_SEND_ATTEMPTS}`;
}

/**
 * A chat's turn, in its afternoon: a note still being sent is settled, one still to go out goes, or else, at most once a
 * day, its news gets a note. One Telegram refused is posted again as it was written while the news is the same.
 * Returns what happened, for the log, or nothing when there was nothing to do.
 */
export async function announceIn(deps: NoteDeps & { api: Api }, chat: Chat, now = new Date()): Promise<string | undefined> {
  const { sql } = deps;
  const timeZone = deps.config.DISPLAY_TIMEZONE;
  if (!isPostingHour(now, timeZone) || !(await stillWanted(sql, chat.id))) return undefined;
  const [latest] = await sql<Note[]>`SELECT * FROM announcements WHERE chat_id = ${chat.id} ORDER BY created_at DESC, id DESC LIMIT 1`;
  if (latest?.status === "sending") return noteLine(await settleSending(sql, latest));
  if (latest?.status === "pending") return noteLine(await sendNote(deps.api, sql, latest));
  if (latest && dayIn(latest.posted_at ?? latest.created_at, timeZone) === dayIn(now, timeZone)) return undefined;
  const data = await noteData(sql, chat, timeZone, deps.capabilities);
  if (data.news.length === 0) return undefined;
  const keys = data.news.map(([key]) => key);
  const refused = latest?.status === "failed" && latest.text !== null && sameKeys([...latest.capabilities, ...latest.ruled_out], keys) ? latest : undefined;
  const written: WrittenNote = refused
    ? { kind: "kept", note: await keepNote(sql, chat.id, { capabilities: refused.capabilities, ruled_out: refused.ruled_out, text: refused.text, status: "pending", reason: null }) }
    : await writeNote(deps, chat, data);
  if (written.kind === "nothing_new") return undefined;
  if (written.note.status !== "pending") return noteLine(written.note);
  if (!(await stillWanted(sql, chat.id))) return "wrote a note, but the notes were turned off here meanwhile: it waits until they are on again";
  return noteLine(await sendNote(deps.api, sql, written.note));
}

/** Every half hour, from half an hour after the start: each approved chat where a note is due gets it. Returns a function that stops it. */
export function startAnnouncements(deps: Omit<NoteDeps, "signal"> & { api: Api; everyMs?: number; startDelayMs?: number }): () => Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const retryAt = new Map<number, number>();
  const stopping = new AbortController();
  let running: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;

  const tick = async () => {
    for (const chat of await approvedChats(deps.sql)) {
      if (stopping.signal.aborted) return;
      if ((retryAt.get(chat.id) ?? 0) > Date.now()) continue;
      const title = chat.title ?? String(chat.id);
      try {
        const line = await announceIn({ ...deps, signal: stopping.signal }, chat);
        retryAt.delete(chat.id);
        if (line) log(`[announcements] ${title}: ${line}`);
      } catch (error) {
        if (stopping.signal.aborted) return;
        retryAt.set(chat.id, Date.now() + RETRY_AFTER_MS);
        if (error instanceof BudgetExceededError) log(`[announcements] ${title}: waits for budget: ${error.message}`);
        else log(`[announcements] ${title}: failed, retrying in an hour: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
  const run = () => {
    if (!running && !stopping.signal.aborted) running = tick().catch((error) => log(`[announcements] tick failed: ${String(error)}`)).finally(() => (running = undefined));
  };

  const first = setTimeout(() => {
    run();
    timer = setInterval(run, deps.everyMs ?? TICK_MS);
  }, deps.startDelayMs ?? START_DELAY_MS);
  return async () => {
    stopping.abort();
    clearTimeout(first);
    clearInterval(timer);
    await running;
  };
}
