import type { Message, User as TelegramUser, UserFromGetMe } from "grammy/types";
import { ambiguousNames, chatAliases, nameForms, namedIn, type Named, type NamedAlias } from "../core/aliases.js";
import type { Sql } from "../core/db.js";
import { FACT_KINDS, MIN_VISIBLE_CONFIDENCE } from "../core/facts.js";
import { memosOf, projectMemos, type Memo, type ProjectMemo } from "../core/memos.js";
import { CONSENT, type NoteKind, type NoteStatus } from "../core/notes.js";
import { maskPersonalData } from "../core/privacy.js";
import {
  ABANDONED_MULTIPLIER,
  formerNames,
  listProjects,
  ratingBreakdown,
  STATUS_LABELS,
  type FormerName,
  type ProjectListItem,
  type RatingBreakdown,
} from "../core/projects.js";
import { slugify, transliterateName, truncate } from "../core/text.js";
import { recurringThemes, wordTerms, type Theme } from "../core/themes.js";
import { peopleOfChat, SERVICE_TG_IDS, type Person } from "../core/users.js";
import { chatClocks, isoDayIn, localDay, localStamp, localTimeOf, offsetAt, zoneGap, zoneLabel, type MemberClock } from "../core/zones.js";
import { skippedMessageIds } from "../worker/extract.js";
import { realReply } from "./kit.js";

/**
 * The data part of an answer's prompt: who the bot is, the members and the names they go by, the catalog and the
 * chronicle, what the chronicler has not processed yet, fuller cards of the people the question is about, the
 * conversation it belongs to and the latest messages. Everything is read from the database; texts go through
 * maskPersonalData. The interjector's prompt (interjector.ts) shares its lines, dates and <about_you>.
 */

/**
 * A piece of the prompt. Answers in a chat come seconds apart, so the prompt cache keeps everything up to a `cached`
 * piece: the chat's memory is the same for every question until something in it changes, and what no pass has taken
 * yet only grows at its end, in chunks that stay byte-identical once complete.
 */
export interface PromptPart {
  text: string;
  cached: boolean;
}

export interface Question {
  chatId: number;
  chatTitle: string | null;
  message: Message;
  from: TelegramUser;
  /** The bot itself (ctx.me). */
  me: UserFromGetMe;
  /** What the sender's own request in this message just changed on their card (src/bot/self-edits.ts). */
  cardChange?: string;
}

/** The answer the bot posted to a question, or null when it posted none (a refusal, a limit, a failure). */
export type Answered = { text: string; msgId: number } | null;

export interface RecentAnswer {
  to: string;
  text: string;
  /** The message the answer was posted as, when it is known. */
  msgId?: number;
}

export interface ReplyContextOptions {
  timezone: string;
  /** The model writing this answer: the bot can say which one it is. */
  model: string;
  ownerTgIds: number[];
  /** Whether to quote what the chronicler has not processed yet (off after the model refused a prompt with it). */
  earlier?: boolean;
  recentAnswers?: RecentAnswer[];
  /** The motif for a comeback, should the question be an insult. */
  insultMotif: string;
}

const CONTEXT_MESSAGES = 30;
const CHRONICLE_DAYS = 30;
const CHRONICLE_ENTRIES = 40;
/** Caps that keep a big chat's prompt well under 100K tokens, where Haiku's price goes up fivefold. */
const MAX_MEMBERS = 150;
const MAX_FACTS_PER_MEMBER = 12;
const MAX_PROJECTS = 60;
const MESSAGE_CHARS = 500;
const THREAD_HOPS = 12;
const THREAD_CHARS = 400;
/** The conversation a question is about runs back to the last pause this long, and is quoted in shorter lines. */
const SEGMENT_PAUSE_MS = 25 * 60_000;
const SEGMENT_MESSAGES = 120;
const SEGMENT_CHARS = 250;
/**
 * Messages the chronicler has not processed yet, older than the latest messages, are quoted in full: the answer would
 * know them from nowhere else. A busy chat gets a pass once a couple of hundred pile up (passDueAt), so the cap only
 * bites when passes stall; then the oldest are left out, a hundred at a time, so the window rarely shifts.
 */
const EARLIER_MESSAGES = 300;
const EARLIER_CHUNK = 25;
const EARLIER_LEFT_OUT_STEP = 100;
const EARLIER_CHARS = 300;
const FOCUS_PEOPLE = 5;
/** About 500 tokens a person, private notes included. */
const FOCUS_CHARS = 1800;
const FOCUS_EXCHANGES = 3;
const FOCUS_TOPICS = 5;
const FOCUS_TOPIC_DAYS = 60;
/** How many of a person's private notes of each kind the focus shows, newest first. */
const FOCUS_NOTES: Partial<Record<NoteKind, number>> = { claim: 4, prediction: 3, stance: 4, correction: 3, bout: 3, bait: 2, about_bot: 2 };
const FOCUS_JOKES = 4;
/** Statuses of a project standing still, and the words a tagline says it with. */
const STILL_STATUSES = new Set(["paused", "abandoned"]);
const STILL_WORDS = /(?<!\p{L})(?:на\s+паузе|пауз\p{L}*|заморож\p{L}*|заброш\p{L}*|paused|on hold|abandoned|frozen)(?!\p{L})/iu;
/** A person's own notes in the focus, and a project's in its details: the newest this many. */
const FOCUS_MEMOS = 5;
const PROJECT_MEMOS = 5;
/** A note the bot's own messages used within this many days is marked as used (later it may come back); the newest this many of them are read. */
const SPENT_DAYS = 1;
const SPENT_MESSAGES = 150;
/** Of the bot's latest answers this many are read for worn words: one that this many of them share is worn out. */
const WORN_ANSWERS = 10;
const WORN_TIMES = 3;
const WORN_SHOWN = 10;
const WORN_MIN_CHARS = 60;
const FOCUS_THEMES = 3;
const THEME_DATES = 5;
/** A claim or a prediction settled this recently still shows. */
const CLOSED_NOTE_DAYS = 30;
const RUNNING_JOKES = 6;
const CORRECTIONS = 6;
const SAID_ABOUT_YOU = 5;
const DETAIL_PROJECTS = 3;
const DETAIL_SIGNALS_PER_KIND = 4;
const AMBIGUOUS_NAMES = 10;

/** Text from members can't open or close a section of the prompt. */
export function safe(text: string): string {
  return text.replace(/</g, "‹").replace(/>/g, "›");
}

/** One masked, prompt-safe line of at most `max` characters. */
export function line(text: string, max: number): string {
  return safe(truncate(maskPersonalData(text.replace(/\s+/g, " ").trim()), max));
}

/** A text without the bot's @username, which would otherwise read as a mention of a project named like the bot. */
function withoutMention(text: string, me: UserFromGetMe): string {
  return text.replace(new RegExp(`@${me.username}\\b`, "gi"), "").replace(/\s+/g, " ").trim();
}

/** The question without the bot's @username. */
export function questionText(message: Message, me: UserFromGetMe): string {
  return withoutMention(message.text ?? message.caption ?? "", me);
}

const CONVERSATION = new RegExp(
  [
    String.raw`(?<!\p{L})(?:диалог|разговор|разговарива|спор(?!т)|обсужд|перепалк|ветк)`,
    String.raw`(?<!\p{L})(?:речь|тред(?:а|е|у|ом|ы|ов)?|рассуди(?:те)?)(?!\p{L})`,
    String.raw`(?<!\p{L})(?:что тут|о ч[её]м вы|мы тут|кто из нас|кто выиграл|запиши(?:те)? это)`,
    String.raw`(?<!\p{L})кто\s+(?:\S+\s+){0,2}прав(?:а|ы)?(?!\p{L})`,
    String.raw`\b(?:dialog(?:ue)?s?|conversations?|argu(?:e|ing|ments?)|debat(?:es?|ing)|discuss(?:ions?|ing)?|threads?|who(?:'s| is) right|settle (?:this|it))\b`,
    String.raw`\bwhat(?:'s| is) going on\b|\bwhat are (?:they|you|we)(?: guys)? (?:talking|arguing) about\b|\bwrite (?:this|that) down\b`,
  ].join("|"),
  "iu",
);

/**
 * The question is about the conversation under way — «запиши этот диалог», «о чём речь ведёте», «рассуди», «кто прав»,
 * "who is right": the bot then reads all of it.
 */
export function refersToConversation(text: string): boolean {
  return CONVERSATION.test(text);
}

const RATING_WORDS = /(?<!\p{L})(?:рейтинг|балл|очк|голос|топ(?:е|а|у|ом)?(?!\p{L})|rating|score|points?(?!\p{L})|vot(?:e|es|ed|ing)(?!\p{L}))/iu;

export function asksAboutRating(text: string): boolean {
  return RATING_WORDS.test(text);
}

export interface Clock {
  timezone: string;
  /** YYYY-MM-DD in the display timezone. */
  today: string;
  /** The zones of the members whose own clock is known: their messages show their time next to the chat's. */
  authors?: Map<number, string>;
}

export const dayOf = (date: Date, timeZone: string) => date.toLocaleDateString("en-CA", { timeZone });

/** «8 Nov», or «8 Nov 2025» in another year. */
export function dateLabel(date: Date, clock: Clock): string {
  const sameYear = dayOf(date, clock.timezone).slice(0, 4) === clock.today.slice(0, 4);
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }), timeZone: clock.timezone });
}

/** «14:05» today, «8 Nov 14:05» on another day. */
function timeLabel(date: Date, clock: Clock): string {
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: clock.timezone });
  return dayOf(date, clock.timezone) === clock.today ? time : `${dateLabel(date, clock)} ${time}`;
}

/** «, Wed 11 Nov 06:30 their time» for an author whose clock differs from the chat's then; nothing otherwise. */
export function theirTime(date: Date, zone: string | undefined, chatZone: string): string {
  if (!zone || offsetAt(zone, date) === offsetAt(chatZone, date)) return "";
  const day = isoDayIn(date, zone) === isoDayIn(date, chatZone) ? "" : `${localDay(date, zone)} `;
  return `, ${day}${localTimeOf(date, zone)} their time`;
}

export interface ContextMessage {
  msg_id: number;
  sent_at: Date;
  text: string;
  media_type: string | null;
  reply_to_bot: boolean;
  reply_to_msg_id: number | null;
  from_bot: boolean;
  /** A forwarded post is not its forwarder's own words. */
  is_forward?: boolean;
  user_id: number | null;
  display_name: string | null;
}

export function messageLine(row: ContextMessage, clock: Clock, max: number): string {
  const author = row.from_bot ? "Waggle" : safe(row.display_name ?? "someone");
  const reply = row.reply_to_bot ? " ↩Waggle" : row.reply_to_msg_id ? ` ↩${row.reply_to_msg_id}` : "";
  const forwarded = row.is_forward ? " [forwarded]" : "";
  const media = row.media_type ? ` [${row.media_type}]` : "";
  const text = line(row.text, max);
  const theirs = row.from_bot || row.user_id === null ? "" : theirTime(row.sent_at, clock.authors?.get(row.user_id), clock.timezone);
  return `[${row.msg_id} ${timeLabel(row.sent_at, clock)}${theirs}] ${author}${reply}${forwarded}${media}${text ? `: ${text}` : ""}`;
}

interface WaitingMessage extends ContextMessage {
  /** Its place among the messages since the chronicler's last pass that wait for it, counted from the oldest. */
  position: number;
}

interface EarlierWindow {
  rows: WaitingMessage[];
  /** Whether older waiting messages are left out (always whole steps of EARLIER_LEFT_OUT_STEP). */
  leftOut: boolean;
  /** The position after the last row. */
  end: number;
}

/** The waiting messages older than the latest ones (oldest first): all of them, or the newest few hundred. */
function earlierWindow(olderWaiting: WaitingMessage[]): EarlierWindow {
  const end = (olderWaiting.at(-1)?.position ?? -1) + 1;
  const start = Math.max(0, Math.ceil((end - EARLIER_MESSAGES) / EARLIER_LEFT_OUT_STEP) * EARLIER_LEFT_OUT_STEP);
  return { rows: olderWaiting.filter((row) => row.position >= start), leftOut: start > 0, end };
}

/**
 * The window in chunks of EARLIER_CHUNK by position, so a chunk reads the same in every answer until the next pass.
 * Only the last complete chunk is marked for the cache: the cache finds the earlier ones by looking back from it.
 */
function earlierParts(window: EarlierWindow, clock: Clock): PromptPart[] {
  if (window.rows.length === 0) return [];
  const lastComplete = Math.floor(window.end / EARLIER_CHUNK) - 1;
  const header = `<earlier_messages note="what the chronicle and the cards do not cover yet: the messages since the chronicler's last pass before the latest 30, oldest first; its end may repeat in current_conversation">${
    window.leftOut ? "\n(older messages since the chronicler's last pass are left out)" : ""
  }`;
  const chunks = [...groupBy(window.rows, (row) => Math.floor(row.position / EARLIER_CHUNK))];
  return chunks.map(([index, rows], order) => ({
    text: `${order === 0 ? `${header}\n` : ""}${rows.map((row) => messageLine(row, clock, EARLIER_CHARS)).join("\n")}\n`,
    cached: index === lastComplete,
  }));
}

/** The run of messages before the question, back to the last pause of SEGMENT_PAUSE_MS between two of them. */
function currentSegment(newestFirst: ContextMessage[]): ContextMessage[] {
  const segment: ContextMessage[] = [];
  for (const row of newestFirst) {
    const later = segment.at(-1);
    if (later && later.sent_at.getTime() - row.sent_at.getTime() >= SEGMENT_PAUSE_MS) break;
    segment.push(row);
  }
  return segment.reverse();
}

const MESSAGE_COLUMNS = "m.msg_id, m.sent_at, m.text, m.media_type, m.reply_to_bot, m.reply_to_msg_id, m.from_bot, m.is_forward, m.user_id, u.display_name";

/** The messages the question replies to, up to the root of the conversation, root first; the bot's own included. */
async function replyChain(sql: Sql, chatId: number, parentId: number): Promise<ContextMessage[]> {
  return sql<ContextMessage[]>`
    WITH RECURSIVE chain AS (
      SELECT msg_id, reply_to_msg_id, 1 AS hops FROM messages WHERE chat_id = ${chatId} AND msg_id = ${parentId}
      UNION ALL
      SELECT m.msg_id, m.reply_to_msg_id, chain.hops + 1
      FROM chain JOIN messages m ON m.chat_id = ${chatId} AND m.msg_id = chain.reply_to_msg_id
      WHERE chain.hops < ${THREAD_HOPS} AND m.msg_id < chain.msg_id
    )
    SELECT ${sql.unsafe(MESSAGE_COLUMNS)}
    FROM chain JOIN messages m ON m.chat_id = ${chatId} AND m.msg_id = chain.msg_id LEFT JOIN users u ON u.id = m.user_id
    ORDER BY chain.hops DESC`;
}

function authorOf(replied: NonNullable<Message["reply_to_message"]>, me: UserFromGetMe): string {
  if (replied.from?.id === me.id) return "Waggle";
  if (replied.sender_chat && "title" in replied.sender_chat) return replied.sender_chat.title ?? "a channel";
  return [replied.from?.first_name, replied.from?.last_name].filter(Boolean).join(" ") || "someone";
}

const ALIAS_SOURCE: Record<NamedAlias["source"], { person: string; project: string }> = {
  owner: { person: "owner", project: "owner" },
  person: { person: "self", project: "author" },
  chronicler: { person: "chronicler", project: "chronicler" },
};

export function aliasLabel(alias: NamedAlias): string {
  return `${safe(maskPersonalData(alias.alias))} (${ALIAS_SOURCE[alias.source][alias.user_id === null ? "project" : "person"]})`;
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}

/** Adds lines while they fit into `budget` characters; the first one that does not is cut short, and the rest left out. */
function withinBudget(lines: string[], budget: number): string[] {
  const kept: string[] = [];
  let left = budget;
  for (const text of lines) {
    if (left <= 1) break;
    kept.push(text.length <= left ? text : truncate(text, left));
    left -= text.length + 1;
  }
  return kept;
}

const points = (value: number) => value.toFixed(1).replace(/\.0$/, "");

interface FocusFact {
  user_id: number;
  kind: string;
  value: string;
  status: string;
  said_at: Date;
}

interface FocusExchange {
  user_id: number;
  asked: string;
  media_type: string | null;
  answer: string;
  sent_at: Date;
}

interface FocusTopic {
  user_id: number;
  title: string;
  summary: string;
  period_to: Date;
}

type FocusReason = "asking" | "replied to" | "named";

/** A current private note; what someone objected to (consent) never comes into an answer. */
interface ContextNote {
  id: number;
  user_id: number | null;
  kind: NoteKind;
  about: string | null;
  value: string;
  status: NoteStatus | null;
  due_at: Date | null;
  user_ids: number[];
  said_at: Date;
}

const NOTE_COLUMNS = "id, user_id, kind, about, value, status, due_at, user_ids, coalesce(said_at, created_at) AS said_at";

const quoted = (note: ContextNote, max = 120) => `“${line(note.value, max)}”`;

export function aboutYouBlock(input: {
  me: UserFromGetMe;
  model: string;
  owners: { id: number; display_name: string; username: string | null }[];
  aliasesOf: Map<number, NamedAlias[]>;
  catalogEntry: { project: ProjectListItem; rank: number; total: number } | undefined;
  saidAboutYou: string[];
}): string {
  const { me } = input;
  const owners = input.owners.map((owner) => {
    const aliases = (input.aliasesOf.get(owner.id) ?? []).map((alias) => safe(maskPersonalData(alias.alias)));
    return `${safe(owner.display_name)}${owner.username ? ` (@${owner.username})` : ""}${aliases.length ? `, also called ${aliases.join(", ")}` : ""}`;
  });
  const entry = input.catalogEntry;
  return [
    "<about_you>",
    `You are ${safe(me.first_name)} (@${me.username}), the chat's chronicler bot; this answer is written by ${input.model}.`,
    owners.length ? `Your ${owners.length > 1 ? "owners, who built you and pay" : "owner, who built you and pays"} for you: ${owners.join("; ")}.` : "",
    "You read the chat and keep the members' cards, the project catalog with its rating and the chronicle, and you answer when someone mentions you or replies to you. A member changes their own card, tagline, time zone, names and notes (about themselves or on a project of theirs) by asking you plainly in the chat: you do it and post a receipt with ↩️ Undo, and ↪️ Redo after an Undo; the Mini App (/app) does the same. A member asks you to remind them of something later the same way: you post a receipt with ✖️ Cancel and, when it is due, write to them in the chat and in a private message; only ever the person who asks, and once, never on repeat. Nobody changes anyone else's data, a project's catalog entry, votes or the rating through you, and you do not vote, run code, browse the web or send images or widgets. /forgetme erases what you know about a person.",
    entry
      ? `In the catalog you are the project ${safe(entry.project.name)}: #${entry.rank} of ${entry.total}, ${entry.project.score} rating points, ${entry.project.votes} vote(s).`
      : "",
    input.saidAboutYou.length ? `What members say about you: ${input.saidAboutYou.join("; ")}.` : "",
    "</about_you>",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The people in a note, by name: those who are not members any more are left out. */
function namesIn(ids: number[], names: Map<number, string>): string[] {
  return ids.flatMap((id) => (names.has(id) ? [safe(names.get(id)!)] : []));
}

function runningJokesBlock(jokes: ContextNote[], names: Map<number, string>, clock: Clock): string {
  const lines = jokes.map((joke) => {
    const people = namesIn(joke.user_ids, names);
    return `- ${joke.about ? `${line(joke.about, 60)}: ` : ""}${quoted(joke, 160)} (${[people.join(", "), dateLabel(joke.said_at, clock)].filter(Boolean).join("; ")})`;
  });
  return lines.length ? `<running_jokes note="the chat's running jokes with their latest twist, newest first">\n${lines.join("\n")}\n</running_jokes>` : "";
}

function correctionsBlock(corrections: ContextNote[], names: Map<number, string>, clock: Clock): string {
  const lines = corrections.map((note) => {
    const about = note.user_id !== null && names.has(note.user_id) ? `about ${safe(names.get(note.user_id)!)}: ` : "";
    return `- ${about}${quoted(note, 160)} (${dateLabel(note.said_at, clock)})`;
  });
  return lines.length ? `<corrections note="what people corrected; it overrides the cards and the chronicle">\n${lines.join("\n")}\n</corrections>` : "";
}

/** A word of a text, lowercased, with the term it counts as. */
export interface Worded {
  word: string;
  term: string;
}

const WORD = /[\p{L}\p{N}]+(?:[.,]\p{N}+)*/gu;
const TERM_LETTERS = 5;
/** Manners, the chat's own subject (projects, the rating, cards) and filler are never a worn motif. */
const NEVER_WORN = /^(?:спасиб|пожалуйст|благодар|прост|извин|thank|pleas|sorry|проект|project|рейтинг|rating|карточ|card|котор|человек|people|person)/u;
const wordsIn = (text: string) => text.toLowerCase().match(WORD) ?? [];

/**
 * Each text's telling words: their terms from Postgres's Russian stemming (core/themes.ts), so «игра» and «игру» meet
 * and stop words drop out, cut to five letters, so «обещал» and «обещание» meet too; a number such as 2.5 as it is.
 */
export async function wordedTexts(sql: Sql, texts: string[]): Promise<Worded[][]> {
  const terms = await wordTerms(sql, [...new Set(texts.flatMap(wordsIn))]);
  return texts.map((text) =>
    wordsIn(text).flatMap((word) => {
      const term = /^\p{N}+[.,]\p{N}+$/u.test(word) ? word : terms.get(word)?.slice(0, TERM_LETTERS);
      return term ? [{ word, term }] : [];
    }),
  );
}

/** Terms in a fifth or more of the bot's own messages: the chat's everyday words («чат», «проект»), no sign of any one note. */
export function backgroundTerms(spoken: { terms: Set<string> }[]): Set<string> {
  if (spoken.length < 10) return new Set();
  const counts = new Map<string, number>();
  for (const message of spoken) for (const term of message.terms) counts.set(term, (counts.get(term) ?? 0) + 1);
  return new Set([...counts].filter(([, count]) => count / spoken.length >= 0.2).map(([term]) => term));
}

/** How many of the bot's own messages used a note already: those that carry most of its terms, or three of a long one's. */
export function broughtUp(note: Worded[], spoken: { terms: Set<string>; sent_at: Date }[], background = new Set<string>()): { times: number; last: Date } | null {
  const terms = [...new Set(note.map(({ term }) => term))].filter((term) => !background.has(term));
  if (terms.length < 2) return null;
  const needed = Math.max(2, Math.min(3, Math.ceil(terms.length * 0.4)));
  const hits = spoken.filter((message) => terms.filter((term) => message.terms.has(term)).length >= needed);
  if (hits.length === 0) return null;
  return { times: hits.length, last: new Date(Math.max(...hits.map((hit) => hit.sent_at.getTime()))) };
}

/** Words that several of the bot's latest answers share: a motif worn thin. `excluded` are terms the question brings up itself. */
export function wornWords(answers: Worded[][], excluded: Set<string>): string[] {
  const counts = new Map<string, { answers: number; forms: Map<string, number> }>();
  for (const answer of answers) {
    const firstForms = new Map<string, string>();
    for (const { word, term } of answer) if (!firstForms.has(term)) firstForms.set(term, word);
    for (const [term, word] of firstForms) {
      const entry = counts.get(term) ?? { answers: 0, forms: new Map<string, number>() };
      entry.answers += 1;
      entry.forms.set(word, (entry.forms.get(word) ?? 0) + 1);
      counts.set(term, entry);
    }
  }
  return [...counts]
    .filter(([term, entry]) => entry.answers >= WORN_TIMES && !excluded.has(term) && ![...entry.forms.keys()].some((form) => NEVER_WORN.test(form)))
    .sort((a, b) => b[1].answers - a[1].answers)
    .slice(0, WORN_SHOWN)
    .map(([, entry]) => [...entry.forms].sort((a, b) => b[1] - a[1])[0]![0]);
}

/** A person's private notes in the focus, one line a kind, each item dated, and marked when the bot already used it. */
function privateLines(input: { person: Person; notes: ContextNote[]; jokes: ContextNote[]; themes: Theme[]; used: Map<number, { times: number; last: Date }>; names: Map<number, string>; clock: Clock }): string[] {
  const { person, clock } = input;
  const of = (kind: NoteKind) => input.notes.filter((note) => note.kind === kind).slice(0, FOCUS_NOTES[kind] ?? 0);
  const used = (note: ContextNote) => {
    const seen = input.used.get(note.id);
    return seen ? `brought up ${seen.times}× lately, last ${dateLabel(seen.last, clock)}` : "";
  };
  const dated = (note: ContextNote, extra: string[] = []) => `${quoted(note)} (${[...extra, dateLabel(note.said_at, clock), used(note)].filter(Boolean).join("; ")})`;
  const status = (note: ContextNote, due: string) =>
    [note.status, note.due_at && note.status === "open" ? `${due} ${dateLabel(note.due_at, clock)}` : ""].filter(Boolean).join(", ");
  const item = (label: string, values: string[]) => (values.length ? [`  🔒 ${label}: ${values.join("; ")}`] : []);

  const jokes = input.jokes.filter((joke) => joke.user_ids.includes(person.id)).slice(0, FOCUS_JOKES);
  const recurring = input.themes
    .filter((theme) => theme.kind === "debate")
    .flatMap((theme) => {
      const own = theme.topics.filter((topic) => topic.user_ids.includes(person.id));
      if (own.length < 2) return [];
      const counts = new Map<number, number>();
      for (const id of own.flatMap((topic) => topic.user_ids)) if (id !== person.id) counts.set(id, (counts.get(id) ?? 0) + 1);
      const others = namesIn([...counts].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([id]) => id), input.names);
      const dates = own.slice(-THEME_DATES).map((topic) => dateLabel(topic.period_to, clock));
      return [`${others.length ? `with ${others.join(" and ")} ` : ""}about “${line(theme.title, 80)}”: ${own.length} times, ${dates.join(", ")}`];
    })
    .slice(0, FOCUS_THEMES);

  return [
    ...item("claims", of("claim").map((note) => dated(note, [status(note, "due")]))),
    ...item("predictions", of("prediction").map((note) => dated(note, [status(note, "check")]))),
    ...item("stances", of("stance").map((note) => `${note.about ? `on ${line(note.about, 60)} ` : ""}${dated(note)}`)),
    ...item("corrections", of("correction").map((note) => dated(note))),
    ...item("bouts with you", of("bout").map((note) => dated(note))),
    ...item("bait", of("bait").map((note) => dated(note))),
    ...item("said about you", of("about_bot").map((note) => dated(note))),
    ...item("running jokes", jokes.map((joke) => line(joke.about ?? joke.value, 60))),
    ...item("keeps coming back to", recurring),
  ];
}

function whoIsWhoBlock(input: {
  people: Person[];
  aliasesOf: Map<number, NamedAlias[]>;
  projects: ProjectListItem[];
  projectAliases: Map<number, NamedAlias[]>;
  former: Map<number, FormerName[]>;
  ambiguous: { names: string[]; ids: number[] }[];
}): string {
  const names = new Map(input.people.map((person) => [person.id, person.display_name]));
  const people = input.people.flatMap((person) => {
    const known = [...transliterateName(person.display_name).map(safe), ...(input.aliasesOf.get(person.id) ?? []).map(aliasLabel)];
    return known.length ? [`${safe(person.display_name)}: ${known.join(", ")}`] : [];
  });
  const projects = input.projects.flatMap((project) => {
    const earlier = [...new Set((input.former.get(project.id) ?? []).map((entry) => entry.name).filter((name) => name.toLowerCase() !== project.name.toLowerCase()))];
    const known = [...(input.projectAliases.get(project.id) ?? []).map(aliasLabel), ...earlier.map((name) => `was ${safe(name)}`)];
    return known.length ? [`#${project.slug} ${safe(project.name)}: ${known.join(", ")}`] : [];
  });
  const flags = input.ambiguous
    .slice(0, AMBIGUOUS_NAMES)
    .map((group) => `“${group.names.map(safe).join("” / “")}” may mean ${group.ids.map((id) => safe(names.get(id) ?? "?")).join(" or ")}`);
  if (people.length + projects.length + flags.length === 0) return "";
  return `<who_is_who note="other spellings and names people use; @usernames are in members">\n${[...people, ...projects, ...flags].join("\n")}\n</who_is_who>`;
}

function projectDetailsBlock(input: {
  ranked: ProjectListItem[];
  picked: ProjectListItem[];
  breakdown: Map<number, RatingBreakdown>;
  former: Map<number, FormerName[]>;
  memos: Map<number, ProjectMemo[]>;
  statusSince: Map<number, Date>;
  clock: Clock;
}): string {
  const { ranked, clock } = input;
  const [leader, second] = ranked;
  const sections = input.picked.map((project) => {
    const rank = ranked.findIndex((candidate) => candidate.id === project.id) + 1;
    const standing =
      leader?.id === project.id
        ? `leads${second ? `; next is ${safe(second.name)} with ${second.score}` : ""}`
        : leader
          ? `the leader ${safe(leader.name)} has ${leader.score} (${leader.score - project.score} more)`
          : "";
    const { votes, signals } = input.breakdown.get(project.id) ?? { votes: [], signals: [] };
    const counted = groupBy(
      signals.filter((signal) => signal.kind !== "milestone" && signal.points > 0),
      (signal) => signal.kind,
    );
    const kinds = [...counted].map(([kind, list]) => {
      const total = list.reduce((sum, signal) => sum + signal.points, 0);
      const shown = list
        .slice(0, DETAIL_SIGNALS_PER_KIND)
        .map((signal) => `impact ${signal.impact}, ${dateLabel(signal.happened_at, clock)} → ${points(signal.points)}`);
      const more = list.length > DETAIL_SIGNALS_PER_KIND ? `; +${list.length - DETAIL_SIGNALS_PER_KIND} more` : "";
      return `${kind} ${points(total)} (${shown.join("; ")}${more})`;
    });
    const milestones = signals
      .filter((signal) => signal.kind === "milestone")
      .map((signal) => `${dateLabel(signal.happened_at, clock)} “${line(signal.note, 80)}” (${signal.points > 0 ? `counts ${points(signal.points)}` : "counts 0 now"})`);
    const renames = (input.former.get(project.id) ?? [])
      .filter((entry) => !entry.merged)
      .map((entry) => `from ${safe(entry.name)} on ${dateLabel(entry.at, clock)}`);
    return [
      `${safe(project.name)} (#${project.slug}): #${rank} of ${ranked.length}, ${project.score} rating points${standing ? `; ${standing}` : ""}. Status: ${STATUS_LABELS[project.status] ?? project.status}${input.statusSince.has(project.id) ? ` since ${dateLabel(input.statusSince.get(project.id)!, clock)}` : ""}.`,
      `Votes: ${votes.length}${votes.length ? ` (${votes.map((at) => dateLabel(at, clock)).join(", ")})` : ""}.`,
      kinds.length ? `Signals counted now, in points: ${kinds.join("; ")}.` : "No other signals count now.",
      project.status === "abandoned" ? `Abandoned: the total is multiplied by ${ABANDONED_MULTIPLIER}.` : "",
      renames.length ? `Renamed ${renames.join(", ")}.` : "",
      milestones.length ? `Milestones of all time: ${milestones.join("; ")}.` : "",
      memoLine("Notes its authors wrote", (input.memos.get(project.id) ?? []).slice(0, PROJECT_MEMOS), clock, (memo) => safe(memo.display_name)),
    ]
      .filter(Boolean)
      .join("\n");
  });
  return sections.length ? `<project_details>\n${sections.join("\n\n")}\n</project_details>` : "";
}

/**
 * When each project's status last changed: the first of the latest run of logged changes with that status (imports and
 * the chronicler log what a project became, people what it was too), else when the project was made.
 */
async function statusDates(sql: Sql, projectIds: number[]): Promise<Map<number, Date>> {
  if (projectIds.length === 0) return new Map();
  const rows = await sql<{ id: number; since: Date }[]>`
    SELECT p.id, coalesce(changed.at, p.created_at) AS since
    FROM projects p
    LEFT JOIN LATERAL (
      SELECT at FROM (
        SELECT c.at, c.after->>'status' AS status, lag(c.after->>'status') OVER (ORDER BY c.at, c.id) AS previous
        FROM change_log c WHERE c.entity = 'project' AND c.entity_id = p.id AND c.after ? 'status'
      ) AS logged
      WHERE previous IS DISTINCT FROM status AND status = p.status
      ORDER BY at DESC LIMIT 1
    ) AS changed ON true
    WHERE p.id = ANY(${projectIds}::int[])`;
  return new Map(rows.map((row) => [row.id, row.since]));
}

/** Notes people wrote themselves, each with its date: their own word, current unless they say otherwise. */
function memoLine<T extends Memo>(label: string, memos: T[], clock: Clock, by?: (memo: T) => string): string {
  if (memos.length === 0) return "";
  return `📝 ${label}: ${memos.map((memo) => `“${line(memo.text, 200)}” (${[by?.(memo), dateLabel(memo.created_at, clock)].filter(Boolean).join(", ")})`).join("; ")}`;
}

function inFocusBlock(input: {
  focus: { person: Person; reason: FocusReason }[];
  facts: Map<number, FocusFact[]>;
  exchanges: Map<number, FocusExchange[]>;
  topics: Map<number, FocusTopic[]>;
  projects: ProjectListItem[];
  notes: Map<number, ContextNote[]>;
  jokes: ContextNote[];
  themes: Theme[];
  used: Map<number, { times: number; last: Date }>;
  memos: Map<number, Memo[]>;
  names: Map<number, string>;
  clock: Clock;
}): string {
  const { clock } = input;
  const people = input.focus.map(({ person, reason }) => {
    const header = `- ${safe(person.display_name)}${person.username ? ` (@${person.username})` : ""}, ${reason}`;
    if (person.opted_out) return `${header}: asked not to collect anything about them`;
    const card = [...groupBy(input.facts.get(person.id) ?? [], (fact) => fact.kind)].map(
      ([kind, facts]) =>
        `${kind.replace("_", " ")}: ${facts.map((fact) => `${safe(fact.value)} (${fact.status === "manual" ? "✍ " : ""}${dateLabel(fact.said_at, clock)})`).join(", ")}`,
    );
    const ranked = input.projects.map((project, index) => ({ project, rank: index + 1 }));
    const own = ranked
      .filter(({ project }) => project.authors.some((author) => author.id === person.id))
      .map(({ project, rank }) => `${safe(project.name)} #${rank} (${project.score} pts, ${STATUS_LABELS[project.status] ?? project.status})`);
    const exchanges = (input.exchanges.get(person.id) ?? []).map(
      (exchange) =>
        `${timeLabel(exchange.sent_at, clock)} “${exchange.asked.trim() ? line(exchange.asked, 100) : `[${exchange.media_type ?? "no text"}]`}” → you: “${line(exchange.answer, 140)}”`,
    );
    const topics = (input.topics.get(person.id) ?? []).map((topic) => `${dateLabel(topic.period_to, clock)}: ${line(`${topic.title} — ${topic.summary}`, 140)}`);
    const notes = privateLines({ person, notes: input.notes.get(person.id) ?? [], jokes: input.jokes, themes: input.themes, used: input.used, names: input.names, clock });
    return withinBudget(
      [
        `${header}${person.tagline ? ` — ${safe(person.tagline)}` : ""}`,
        card.length ? `  card: ${card.join("; ")}` : "  card: nothing yet",
        own.length ? `  projects: ${own.join(", ")}` : "",
        memoLine("notes they wrote themselves", (input.memos.get(person.id) ?? []).slice(0, FOCUS_MEMOS), clock).replace(/^📝/, "  📝"),
        ...notes,
        exchanges.length ? `  with you lately: ${exchanges.join("; ")}` : "",
        topics.length ? `  in the chronicle: ${topics.join("; ")}` : "",
      ].filter(Boolean),
      FOCUS_CHARS,
    ).join("\n");
  });
  return people.length
    ? `<in_focus note="the people this question is about; dates say when a fact was said, ✍ marks what the person wrote themselves, 📝 notes they wrote themselves, 🔒 your private notes: use them, never say you keep them; «brought up» marks one your own messages already used lately">\n${people.join("\n")}\n</in_focus>`
    : "";
}

const CLOCK_SOURCES: Record<MemberClock["source"], string> = {
  chat: "they set it in the chat",
  app: "they set it in the Mini App",
  device: "from their device",
  card: "from the place on their card",
  chat_zone: "the chat's",
};

/** The day after `at` in a zone: «Thu 12 Nov». */
function nextDay(at: Date, zone: string): string {
  const [year, month, day] = isoDayIn(at, zone).split("-").map(Number) as [number, number, number];
  return localDay(new Date(Date.UTC(year, month - 1, day + 1, 12)), "UTC");
}

/**
 * The time now for the chat and for each person the question is about, by their own clock, with their today and
 * tomorrow: what «завтра» means in their words. A place on a card that spans several zones leaves the clock unclear.
 */
export function localTimesBlock(focus: { person: Person; reason: FocusReason }[], clocks: Map<number, MemberClock>, chatZone: string, now: Date): string {
  const chat = `- the chat: ${localStamp(now, chatZone)}, ${chatZone}; today ${localDay(now, chatZone)}, tomorrow ${nextDay(now, chatZone)}`;
  const people = focus
    .filter(({ person }) => !person.opted_out)
    .map(({ person, reason }) => {
      const who = `- ${safe(person.display_name)}${person.username ? ` (@${person.username})` : ""}, ${reason}`;
      const clock = clocks.get(person.id);
      if (clock?.unclear && clock.place) {
        return `${who}: unknown: their card says «${safe(line(clock.place, 60))}», which spans ${clock.unclear} time zones, and nothing on it tells which yet, so the chat's time stands in`;
      }
      if (!clock || clock.source === "chat_zone") return `${who}: the chat's time (no zone of their own)`;
      const source = clock.source === "card" && clock.place ? `${CLOCK_SOURCES.card}, «${safe(line(clock.place, 60))}»` : CLOCK_SOURCES[clock.source];
      const gap = zoneGap(clock.zone, chatZone, now);
      return `${who}: ${localStamp(now, clock.zone)}, ${zoneLabel(clock.zone)} (${source}), ${gap ? `${gap} the chat` : "the chat's time"}; their today ${localDay(now, clock.zone)}, their tomorrow ${nextDay(now, clock.zone)}`;
    });
  return `<local_times note="the time now by each one's own clock; the days and times people write («завтра», «вечером», «в 10») are theirs">\n${[chat, ...people].join("\n")}\n</local_times>`;
}

/**
 * Everything the app knows about the chat, as the reply prompt's data: the chat's memory first, the same for every
 * question, then what the chronicler has not processed yet, then all that depends on the question.
 */
export async function buildReplyContext(sql: Sql, question: Question, options: ReplyContextOptions): Promise<PromptPart[]> {
  const { chatId, message, me } = question;
  const now = new Date();
  const clock: Clock = { timezone: options.timezone, today: dayOf(now, options.timezone) };
  const asked = questionText(message, me);
  const aboutConversation = refersToConversation(asked);
  const replied = realReply(message);
  // Messages the chronicler skipped because the model refused them are kept out here too.
  const skipped = await skippedMessageIds(sql, chatId);
  const [clocks, people, facts, projects, chronicle, latest, waiting, chain, aliases, former, owners, chatNotes] = await Promise.all([
    chatClocks(sql, chatId, options.timezone),
    peopleOfChat(sql, chatId),
    sql<{ user_id: number; kind: string; value: string }[]>`
      SELECT user_id, kind, value FROM facts
      WHERE chat_id = ${chatId} AND (status = 'manual' OR (status = 'auto' AND confidence >= ${MIN_VISIBLE_CONFIDENCE}))
      ORDER BY user_id, array_position(${[...FACT_KINDS]}::text[], kind), status = 'manual' DESC, confidence DESC, id`,
    listProjects(sql, chatId, { sort: "top" }),
    sql<{ title: string; summary: string; period_to: Date }[]>`
      SELECT title, summary, period_to FROM chronicle
      WHERE chat_id = ${chatId} AND importance >= 2 AND period_to > ${clock.today}::date - ${CHRONICLE_DAYS}::int
      ORDER BY period_to DESC, id DESC LIMIT ${CHRONICLE_ENTRIES}`,
    sql<ContextMessage[]>`
      SELECT ${sql.unsafe(MESSAGE_COLUMNS)}
      FROM messages m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.chat_id = ${chatId} AND m.msg_id < ${message.message_id} AND m.msg_id <> ALL(${skipped}::bigint[])
        AND (btrim(m.text) <> '' OR m.media_type IS NOT NULL)
      ORDER BY m.msg_id DESC LIMIT ${aboutConversation ? SEGMENT_MESSAGES : CONTEXT_MESSAGES}`,
    // Enough of the newest waiting messages to fill the window before the latest ones. Only those since the last pass:
    // an old message edited since waits again, but stays out (it would shift every chunk). Nothing of anyone who asked
    // not to be recorded: this is memory, not the conversation under way.
    sql<WaitingMessage[]>`
      SELECT * FROM (
        SELECT ${sql.unsafe(MESSAGE_COLUMNS)}, (row_number() OVER (ORDER BY m.msg_id) - 1)::int AS position
        FROM messages m LEFT JOIN users u ON u.id = m.user_id
        WHERE m.chat_id = ${chatId} AND m.extracted_at IS NULL AND m.msg_id < ${message.message_id}
          AND m.msg_id > (SELECT coalesce(max(last_msg_id), 0) FROM extraction_runs WHERE chat_id = ${chatId} AND status = 'done')
          AND m.msg_id <> ALL(${skipped}::bigint[]) AND btrim(m.text) <> ''
          AND NOT EXISTS (SELECT 1 FROM members mb WHERE mb.chat_id = m.chat_id AND mb.user_id = m.user_id AND mb.opted_out)
      ) AS waiting
      ORDER BY msg_id DESC LIMIT ${options.earlier === false ? 0 : EARLIER_MESSAGES + EARLIER_LEFT_OUT_STEP + CONTEXT_MESSAGES}`,
    replied ? replyChain(sql, chatId, replied.message_id) : Promise.resolve([]),
    chatAliases(sql, chatId),
    formerNames(sql, chatId),
    options.ownerTgIds.length
      ? sql<{ id: number; display_name: string; username: string | null }[]>`
          SELECT id, display_name, username FROM users WHERE tg_id = ANY(${options.ownerTgIds}::bigint[]) ORDER BY id`
      : Promise.resolve([]),
    // Always at hand: the running jokes, what people corrected and what they say about the bot.
    sql<ContextNote[]>`
      SELECT ${sql.unsafe(NOTE_COLUMNS)} FROM notes
      WHERE chat_id = ${chatId} AND superseded_by IS NULL AND kind IN ('bit', 'correction', 'about_bot') AND about IS DISTINCT FROM ${CONSENT}
      ORDER BY coalesce(said_at, created_at) DESC, id DESC
      LIMIT 100`,
  ]);

  clock.authors = new Map([...clocks].filter(([, own]) => own.source !== "chat_zone").map(([userId, own]) => [userId, own.zone]));
  const inContext = people.slice(0, MAX_MEMBERS);
  const aliasesOf = groupBy(
    aliases.filter((alias) => alias.user_id !== null),
    (alias) => alias.user_id!,
  );
  const projectAliases = groupBy(
    aliases.filter((alias) => alias.project_id !== null),
    (alias) => alias.project_id!,
  );
  const formerOf = groupBy(former, (entry) => entry.project_id);

  const shown = (row: ContextMessage) => Boolean(row.text.trim() || row.media_type) && !skipped.includes(row.msg_id);
  const thread = chain.filter(shown);
  const parentStored = replied ? chain.some((row) => row.msg_id === replied.message_id) : false;
  const conversation = aboutConversation ? currentSegment(latest) : [...latest].reverse();
  // The window ends where the latest 30 begin in either mode, so a referee's question reuses the same cached chunks.
  const latestFrom = (latest[CONTEXT_MESSAGES - 1] ?? latest.at(-1))?.msg_id ?? message.message_id;
  const earlier = earlierParts(earlierWindow(waiting.filter((row) => row.msg_id < latestFrom).reverse()), clock);

  // The people this question is about: who asks, whose message it answers, and whoever it or its thread names.
  const named: Named[] = inContext.map((person) => ({
    id: person.id,
    username: person.username,
    forms: nameForms(person.display_name, (aliasesOf.get(person.id) ?? []).map((alias) => alias.alias)),
  }));
  const byId = new Map(people.map((person) => [person.id, person]));
  const focus = new Map<number, FocusReason>();
  const asker = people.find((person) => person.tg_id === question.from.id);
  if (asker) focus.set(asker.id, "asking");
  const parentRow = replied ? chain.find((row) => row.msg_id === replied.message_id) : undefined;
  const parentAuthor =
    parentRow?.user_id ??
    (replied?.from && !replied.from.is_bot && !SERVICE_TG_IDS.includes(replied.from.id) ? people.find((person) => person.tg_id === replied.from!.id)?.id : undefined);
  if (parentAuthor !== undefined && !focus.has(parentAuthor) && byId.has(parentAuthor)) focus.set(parentAuthor, "replied to");
  // Telegram's copy of a replied-to message that is not stored still says who and what the question is about.
  const unstoredParent = replied && !parentStored ? (replied.text ?? replied.caption ?? "") : "";
  const threadTexts = [...thread.map((row) => row.text).reverse(), unstoredParent].filter(Boolean).map((text) => withoutMention(text, me));
  for (const id of namedIn([asked, ...threadTexts], named)) {
    if (!focus.has(id)) focus.set(id, "named");
  }
  const focusPeople = [...focus].slice(0, FOCUS_PEOPLE).map(([id, reason]) => ({ person: byId.get(id)!, reason }));
  const focusIds = focusPeople.map((entry) => entry.person.id);

  // Projects the question or its thread names, by any name they had; for a question about the rating that names none,
  // the asker's own.
  const projectNames: Named[] = projects.map((project) => {
    const names = [
      project.name,
      project.slug.replace(/-/g, " "),
      ...(projectAliases.get(project.id) ?? []).map((alias) => alias.alias),
      ...(formerOf.get(project.id) ?? []).map((entry) => entry.name),
    ];
    return { id: project.id, forms: [...new Set([...names, ...names.flatMap(transliterateName)])] };
  });
  let pickedIds = namedIn([asked, ...threadTexts], projectNames);
  if (pickedIds.length === 0 && asker && asksAboutRating(asked)) {
    pickedIds = projects.filter((project) => project.authors.some((author) => author.id === asker.id)).map((project) => project.id);
  }
  const picked = pickedIds.slice(0, DETAIL_PROJECTS).map((id) => projects.find((project) => project.id === id)!);

  const answers = options.recentAnswers ?? [];
  const visibleIds = new Set([...conversation, ...thread].map((row) => row.msg_id));
  const answerIds = answers.map((answer) => answer.msgId).filter((id): id is number => id !== undefined);
  const [focusFacts, exchanges, topics, breakdown, pickedMemos, focusMemos, blanked, focusNotes, themes, spokenRows] = await Promise.all([
    focusIds.length
      ? sql<FocusFact[]>`
          SELECT f.user_id, f.kind, f.value, f.status,
                 coalesce((SELECT max(m.sent_at) FROM messages m WHERE m.chat_id = f.chat_id AND m.msg_id = ANY(f.source_msg_ids)), f.created_at) AS said_at
          FROM facts f
          WHERE f.chat_id = ${chatId} AND f.user_id = ANY(${focusIds}) AND (f.status = 'manual' OR (f.status = 'auto' AND f.confidence >= ${MIN_VISIBLE_CONFIDENCE}))
          ORDER BY f.user_id, array_position(${[...FACT_KINDS]}::text[], f.kind), f.status = 'manual' DESC, f.confidence DESC, f.id`
      : Promise.resolve([]),
    focusIds.length
      ? sql<FocusExchange[]>`
          SELECT user_id, asked, media_type, answer, sent_at FROM (
            SELECT q.user_id, q.text AS asked, q.media_type, a.text AS answer, a.sent_at,
                   row_number() OVER (PARTITION BY q.user_id ORDER BY a.msg_id DESC) AS n
            FROM messages a JOIN messages q ON q.chat_id = a.chat_id AND q.msg_id = a.reply_to_msg_id
            WHERE a.chat_id = ${chatId} AND a.from_bot AND btrim(a.text) <> '' AND q.user_id = ANY(${focusIds})
          ) AS latest
          WHERE n <= ${FOCUS_EXCHANGES}
          ORDER BY sent_at`
      : Promise.resolve([]),
    focusIds.length
      ? sql<FocusTopic[]>`
          SELECT p.user_id, c.title, c.summary, c.period_to
          FROM unnest(${focusIds}::int[]) AS p(user_id)
          CROSS JOIN LATERAL (
            SELECT title, summary, period_to FROM chronicle
            WHERE chat_id = ${chatId} AND p.user_id = ANY(user_ids) AND importance >= 2 AND period_to > now() - ${`${FOCUS_TOPIC_DAYS} days`}::interval
            ORDER BY period_to DESC LIMIT ${FOCUS_TOPICS}
          ) AS c`
      : Promise.resolve([]),
    ratingBreakdown(sql, picked.map((project) => project.id)),
    projectMemos(sql, picked.map((project) => project.id)),
    memosOf(sql, chatId, focusIds),
    // An answer whose stored text is gone (expired, or erased with /forgetme) is not repeated from memory either.
    answerIds.length
      ? sql<{ msg_id: number }[]>`SELECT msg_id FROM messages WHERE chat_id = ${chatId} AND msg_id = ANY(${answerIds}) AND btrim(text) = ''`
      : Promise.resolve([]),
    focusIds.length
      ? sql<ContextNote[]>`
          SELECT ${sql.unsafe(NOTE_COLUMNS)} FROM notes
          WHERE chat_id = ${chatId} AND superseded_by IS NULL AND user_id = ANY(${focusIds}) AND kind <> 'bit' AND about IS DISTINCT FROM ${CONSENT}
            AND (kind NOT IN ('claim', 'prediction') OR status = 'open' OR updated_at > now() - ${`${CLOSED_NOTE_DAYS} days`}::interval)
          ORDER BY coalesce(said_at, created_at) DESC, id DESC`
      : Promise.resolve([]),
    focusIds.length ? recurringThemes(sql, chatId) : Promise.resolve([]),
    // The bot's own words of the last days, its receipts for card and reminder requests and the reminders it delivered aside, newest first.
    sql<{ text: string; sent_at: Date }[]>`
      SELECT m.text, m.sent_at FROM messages m
      WHERE m.chat_id = ${chatId} AND m.from_bot AND btrim(m.text) <> '' AND m.sent_at > now() - ${`${SPENT_DAYS} days`}::interval
        AND NOT EXISTS (SELECT 1 FROM self_edits s WHERE s.chat_id = m.chat_id AND s.receipt_msg_id = m.msg_id)
        AND NOT EXISTS (SELECT 1 FROM reminders r WHERE r.chat_id = m.chat_id AND m.msg_id IN (r.chat_msg_id, r.receipt_msg_id))
      ORDER BY m.msg_id DESC LIMIT ${SPENT_MESSAGES}`,
  ]);
  // What the bot's own words of the last days already used: the notes they brought up, and the words they wore out.
  const noteText = (note: ContextNote) => `${note.about ?? ""} ${note.value}`;
  const askerNames = asker ? [asker.display_name, ...(aliasesOf.get(asker.id) ?? []).map((alias) => alias.alias)] : [];
  const askedAbout = `${asked} ${threadTexts.join(" ")} ${question.from.first_name} ${question.from.last_name ?? ""} ${askerNames.join(" ")}`;
  const worded = await wordedTexts(sql, [...spokenRows.map((row) => row.text), ...focusNotes.map(noteText), askedAbout]);
  const spokenWords = worded.slice(0, spokenRows.length);
  const spoken = spokenRows.map((row, index) => ({ terms: new Set(spokenWords[index]!.map(({ term }) => term)), sent_at: row.sent_at }));
  const used = new Map<number, { times: number; last: Date }>();
  const background = backgroundTerms(spoken);
  focusNotes.forEach((note, index) => {
    const seen = broughtUp(worded[spokenRows.length + index]!, spoken, background);
    if (seen) used.set(note.id, seen);
  });
  const latestAnswers = spokenWords.filter((_, index) => spokenRows[index]!.text.length >= WORN_MIN_CHARS).slice(0, WORN_ANSWERS);
  const worn = wornWords(latestAnswers, new Set(worded.at(-1)!.map(({ term }) => term)));

  const factsOf = new Map<number, Map<string, string[]>>();
  for (const fact of facts) {
    const kinds = factsOf.get(fact.user_id) ?? new Map<string, string[]>();
    kinds.set(fact.kind, [...(kinds.get(fact.kind) ?? []), fact.value]);
    factsOf.set(fact.user_id, kinds);
  }
  // peopleOfChat lists the most recently active first, which picks who fits; the chat's memory lists them in a fixed
  // order and with the same cards whoever asks, so it reads the same in every answer.
  const roster = [...inContext].sort((a, b) => a.id - b.id);
  const members = roster.map((person) => {
    const who = safe(`${person.display_name}${person.username ? ` (@${person.username})` : ""}`);
    if (person.opted_out) return `- ${who}: asked not to collect anything about them`;
    const tagline = person.tagline ? ` — ${safe(person.tagline)}` : "";
    let room = MAX_FACTS_PER_MEMBER;
    const card = [...(factsOf.get(person.id) ?? new Map<string, string[]>())].flatMap(([kind, values]) => {
      const kept = values.slice(0, Math.max(0, room));
      room -= kept.length;
      return kept.length ? [`${kind.replace("_", " ")}: ${safe(kept.join(", "))}`] : [];
    });
    return `- ${who}${tagline}${card.length ? ` | ${card.join("; ")}` : ""}`;
  });

  const statusSince = await statusDates(sql, projects.slice(0, MAX_PROJECTS).map((project) => project.id));
  const catalog = projects.slice(0, MAX_PROJECTS).map((project, index) => {
    const links = [project.links.repo, project.links.site, ...(project.links.other ?? [])].filter(Boolean).join(" ");
    // A tagline written while a project stood still outlives its comeback: the status says where it is now.
    const stale = project.tagline && !STILL_STATUSES.has(project.status) ? STILL_WORDS.exec(project.tagline) : null;
    const signals = project.recent_signals.map((signal) => signal.note).slice(0, 3);
    return safe(
      [
        `${index + 1}. ${project.name} — ${project.status.replace("_", " ")}${statusSince.has(project.id) ? ` since ${dateLabel(statusSince.get(project.id)!, clock)}` : ""}, ${project.score} rating points, ${project.votes} vote(s)`,
        project.authors.length ? `by ${project.authors.map((author) => author.display_name).join(", ")}` : "",
        project.tagline ? `“${project.tagline}”${stale ? ` (an old tagline: it says «${stale[0]}», but the status, ${project.status.replace("_", " ")}, is current)` : ""}` : "",
        project.stack.length ? `stack: ${project.stack.join(", ")}` : "",
        links ? `links: ${links}` : "",
        signals.length ? `recent: ${signals.join("; ")}` : "",
      ]
        .filter(Boolean)
        .join("; "),
    );
  });

  const topicsList = chronicle.map((entry) => `- ${dayOf(entry.period_to, clock.timezone)}: ${safe(`${entry.title} — ${entry.summary}`)}`);
  const catalogIndex = projects.findIndex((project) => [slugify(me.first_name), "waggle"].includes(project.slug) || project.name.toLowerCase() === me.first_name.toLowerCase());

  const threadLines = thread.map((row) => messageLine(row, clock, THREAD_CHARS));
  const repliedToBot = replied?.from?.id === me.id;
  if (replied && unstoredParent.trim() && !repliedToBot) {
    threadLines.push(`[${replied.message_id} ${timeLabel(new Date(replied.date * 1000), clock)}] ${safe(authorOf(replied, me))}: ${line(unstoredParent, THREAD_CHARS)}`);
  }
  const forgotten = new Set(blanked.map((row) => row.msg_id));
  const earlierAnswers = answers.filter((answer) => answer.msgId === undefined || (!visibleIds.has(answer.msgId) && !forgotten.has(answer.msgId)));
  const askerName = `${question.from.first_name}${question.from.last_name ? ` ${question.from.last_name}` : ""}${question.from.username ? ` (@${question.from.username})` : ""}`;
  const conversationLines = conversation.map((row) => messageLine(row, clock, aboutConversation ? SEGMENT_CHARS : MESSAGE_CHARS));

  // The chat-wide lists are the same whoever asks; the focus repeats its people's own corrections and words about the bot.
  const names = new Map(people.filter((person) => !person.opted_out).map((person) => [person.id, person.display_name]));
  const jokes = chatNotes.filter((note) => note.kind === "bit");
  const corrections = chatNotes.filter((note) => note.kind === "correction").slice(0, CORRECTIONS);
  const saidAboutYou = chatNotes
    .filter((note) => note.kind === "about_bot")
    .slice(0, SAID_ABOUT_YOU)
    .map((note) => `${quoted(note)} (${[...namesIn(note.user_id === null ? [] : [note.user_id], names), dateLabel(note.said_at, clock)].join(", ")})`);
  const rosterNamed = [...named].sort((a, b) => a.id - b.id);

  const memory = [
    `<chat title="${safe(question.chatTitle ?? "").replace(/"/g, "'")}" today="${clock.today}" timezone="${clock.timezone}" />`,
    aboutYouBlock({
      me,
      model: options.model,
      owners,
      aliasesOf,
      catalogEntry: catalogIndex >= 0 ? { project: projects[catalogIndex]!, rank: catalogIndex + 1, total: projects.length } : undefined,
      saidAboutYou,
    }),
    `<members>\n${members.join("\n") || "(none yet)"}\n</members>`,
    whoIsWhoBlock({ people: roster, aliasesOf, projects: projects.slice(0, MAX_PROJECTS), projectAliases, former: formerOf, ambiguous: ambiguousNames(rosterNamed) }),
    correctionsBlock(corrections, names, clock),
    `<projects rating="best first">\n${catalog.join("\n") || "(none yet)"}\n</projects>`,
    `<chronicle days="${CHRONICLE_DAYS}" order="newest first">\n${topicsList.join("\n") || "(nothing yet)"}\n</chronicle>`,
    runningJokesBlock(jokes.slice(0, RUNNING_JOKES), names, clock),
  ];
  const aboutQuestion = [
    earlier.length ? "</earlier_messages>" : "",
    projectDetailsBlock({ ranked: projects, picked, breakdown, former: formerOf, memos: groupBy(pickedMemos, (memo) => memo.project_id!), statusSince, clock }),
    inFocusBlock({
      focus: focusPeople,
      facts: groupBy(focusFacts, (fact) => fact.user_id),
      exchanges: groupBy(
        exchanges.map((exchange) => ({ ...exchange, asked: withoutMention(exchange.asked, me) })),
        (exchange) => exchange.user_id,
      ),
      topics: groupBy(topics, (topic) => topic.user_id),
      projects,
      notes: groupBy(focusNotes, (note) => note.user_id!),
      jokes,
      themes,
      used,
      memos: groupBy(focusMemos, (memo) => memo.user_id),
      names,
      clock,
    }),
    localTimesBlock(focusPeople, clocks, options.timezone, now),
    aboutConversation
      ? `<current_conversation note="everything since the last pause of 25 minutes or more, oldest first">\n${conversationLines.join("\n") || "(none)"}\n</current_conversation>`
      : `<recent_messages>\n${conversationLines.join("\n") || "(none)"}\n</recent_messages>`,
    earlierAnswers.length
      ? `<your_recent_answers>\n${earlierAnswers.map((answer) => `- to ${safe(answer.to)}: ${line(answer.text, 600)}`).join("\n")}\n</your_recent_answers>`
      : "",
    threadLines.length ? `<thread note="the messages the question replies to, root first">\n${threadLines.join("\n")}\n</thread>` : "",
    // A message of the bot's from before it kept its own messages: Telegram's copy stands in.
    repliedToBot && unstoredParent ? `<your_message_they_reply_to>\n${line(unstoredParent, 1500)}\n</your_message_they_reply_to>` : "",
    question.cardChange
      ? `<card_change note="what the bot did about this message's request to change the sender's card or to remind them of something; its reply already said it">${line(question.cardChange, 600)}</card_change>`
      : "",
    worn.length ? `<worn_out note="what your latest answers kept coming back to">${worn.map(safe).join(", ")}</worn_out>` : "",
    `<if_insulted motif="${options.insultMotif}" />`,
    // Right before the question, where a smaller model still has it in mind: the tone of the answer follows this message.
    `<answer_in_kind>kindness, thanks or a gift: warmth and real thanks, no jab, yet it buys no side and outranks no work; banter: banter, sharpest about work that stalls; an insult: the menacing chronicler</answer_in_kind>`,
    `<question from="${safe(askerName).replace(/"/g, "'")}">\n${line(asked, 1500)}\n</question>`,
  ];
  const text = (blocks: string[]) => blocks.filter(Boolean).join("\n\n");
  return [{ text: `${text(memory)}\n\n`, cached: true }, ...earlier, { text: text(aboutQuestion), cached: false }];
}

/** The parts as one text, the way the model reads them. */
export function promptText(parts: PromptPart[]): string {
  return parts.map((part) => part.text).join("");
}
