import type { Sql } from "../core/db.js";
import type { Fact } from "../core/facts.js";
import { detectLanguage } from "../core/language.js";
import type { StoredMessage } from "../core/messages.js";
import type { NoteKind, NoteStatus } from "../core/notes.js";
import { maskPersonalData } from "../core/privacy.js";
import type { ProjectStatus } from "../core/projects.js";
import { truncate } from "../core/text.js";
import { peopleOfChat, type Person } from "../core/users.js";

/**
 * A batch of a chat's messages with what the chronicler is shown along with it, and how the messages read in a prompt.
 * Both of the chronicler's calls (extract.ts for the public layer, notes-extract.ts for the private notes) and the notes
 * backfill share it, so every call sees the same masked messages under the same date lines.
 */

const CONTEXT_MESSAGES = 20;
/** Of each person's current notes the notes call is shown the newest this many, and as many of the chat's running jokes. */
const PROMPT_NOTES_PER_PERSON = 8;
const PROMPT_BITS = 12;

/** A current private note as the notes call sees it, to update rather than repeat. */
export interface PromptNote {
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

export interface BatchData {
  chatId: number;
  batch: StoredMessage[];
  context: StoredMessage[];
  users: Person[];
  facts: Fact[];
  projects: { slug: string; name: string; status: ProjectStatus; authors: string[] }[];
  /** Topics of the last days; a stance in a debate that goes on is linked to its topic. */
  recentTopics?: { id?: number; title: string; kind?: string; period_to: Date }[];
  /** The current notes of the people involved, and the chat's running jokes. */
  notes?: PromptNote[];
  /** Telegram ids of the bot's owners: their word about a project's name counts like its authors'. */
  ownerTgIds?: number[];
  /** For the date lines among the messages; UTC when not set. */
  timezone?: string;
}

export const MESSAGE_COLUMNS = "chat_id, msg_id, user_id, sent_at, text, reply_to_msg_id, reply_to_bot, is_forward, forward_source, media_type, from_bot";

export const skippedKey = (chatId: number) => `extraction_skipped:${chatId}`;

/** Messages the model refused: they are kept out of every later prompt. */
export async function skippedMessageIds(sql: Sql, chatId: number): Promise<number[]> {
  const [state] = await sql<{ value: { msg_ids?: number[] } }[]>`SELECT value FROM app_state WHERE key = ${skippedKey(chatId)}`;
  return state?.value.msg_ids ?? [];
}

/** Everything the chronicler is shown along with a batch of messages: the context before it, the people, the catalog, the notes. */
/** What the chronicler reads instead of a request to the bot about someone's card: never a source for anyone's data. */
const CARD_REQUEST_TEXTS: Record<string, string> = {
  edit: "[asked the bot to change their own card; the bot handled it]",
  about_others: "[asked the bot to change another member's card; the bot refused]",
  fake_claim: "[asked the bot to say it changed someone's data; the bot refused]",
  unclear: "[asked the bot to change their card without saying what]",
  parsing: "[a request to the bot about a card]",
};

/**
 * Requests to change a card are handled by the bot itself (src/bot/self-edits.ts): the chronicler sees only that one
 * was made, so it can neither apply one again, nor bring back what its author undid, nor take a request about another
 * member as a fact or a correction about them.
 */
async function withoutCardRequests(sql: Sql, chatId: number, messages: StoredMessage[]): Promise<StoredMessage[]> {
  if (messages.length === 0) return messages;
  const requests = await sql<{ msg_id: number; kind: string }[]>`
    SELECT msg_id, kind FROM self_edits WHERE chat_id = ${chatId} AND msg_id = ANY(${messages.map((message) => message.msg_id)}::bigint[]) AND kind <> 'not_a_request'`;
  const kinds = new Map(requests.map((request) => [request.msg_id, request.kind]));
  return messages.map((message) => (kinds.has(message.msg_id) ? { ...message, text: CARD_REQUEST_TEXTS[kinds.get(message.msg_id)!] ?? CARD_REQUEST_TEXTS.parsing! } : message));
}

export async function batchDataFor(sql: Sql, chatId: number, rawBatch: StoredMessage[]): Promise<BatchData> {
  const batch = await withoutCardRequests(sql, chatId, rawBatch);
  const skipped = await skippedMessageIds(sql, chatId);
  // A message whose text was cleared after the retention period has nothing left to show; media still says what was sent.
  const context = (
    await sql<StoredMessage[]>`
      SELECT ${sql.unsafe(MESSAGE_COLUMNS)}
      FROM messages
      WHERE chat_id = ${chatId} AND msg_id < ${batch[0]!.msg_id} AND msg_id <> ALL(${skipped}::bigint[])
        AND (btrim(text) <> '' OR media_type IS NOT NULL)
      ORDER BY msg_id DESC
      LIMIT ${CONTEXT_MESSAGES}`
  ).reverse();
  const shownContext = await withoutCardRequests(sql, chatId, context);

  const authorIds = [...new Set(batch.map((message) => message.user_id).filter((id): id is number => id !== null))];
  const users = (await peopleOfChat(sql, chatId, { includeLeft: true })).filter((person) => person.left_at === null || authorIds.includes(person.id));
  const involved = involvedUserIds(batch, [...context, ...batch], users);
  const facts = involved.length
    ? await sql<Fact[]>`SELECT * FROM facts WHERE chat_id = ${chatId} AND user_id = ANY(${involved}) AND status IN ('auto', 'manual') ORDER BY user_id, kind, id`
    : [];
  const projects = await sql<BatchData["projects"]>`
    SELECT p.slug, p.name, p.status,
           coalesce(array_agg('u' || pm.user_id) FILTER (WHERE pm.user_id IS NOT NULL), '{}') AS authors
    FROM projects p LEFT JOIN project_members pm ON pm.project_id = p.id
    WHERE p.chat_id = ${chatId} AND NOT p.hidden
    GROUP BY p.id
    ORDER BY p.name`;
  const recentTopics = await sql<{ id: number; title: string; kind: string; period_to: Date }[]>`
    SELECT id, title, kind, period_to FROM chronicle
    WHERE chat_id = ${chatId} AND period_to > ${batch[0]!.sent_at}::timestamptz - interval '3 days'
    ORDER BY period_to DESC
    LIMIT 25`;
  // Bouts and bait are events, never updated, so they are not shown.
  const notes = await sql<PromptNote[]>`
    SELECT id, user_id, kind, about, value, status, due_at, user_ids, said_at FROM (
      SELECT n.id, n.user_id, n.kind, n.about, n.value, n.status, n.due_at, n.user_ids, coalesce(n.said_at, n.created_at) AS said_at,
             row_number() OVER (PARTITION BY n.user_id ORDER BY coalesce(n.said_at, n.created_at) DESC, n.id DESC) AS rank
      FROM notes n
      WHERE n.chat_id = ${chatId} AND n.superseded_by IS NULL AND n.kind NOT IN ('bout', 'bait')
        AND (n.user_id = ANY(${involved}::int[]) OR (n.kind = 'bit' AND n.user_id IS NULL))
    ) AS current
    WHERE rank <= CASE WHEN user_id IS NULL THEN ${PROMPT_BITS}::int ELSE ${PROMPT_NOTES_PER_PERSON}::int END
    ORDER BY user_id NULLS FIRST, said_at`;
  return { chatId, batch, context: shownContext, users, facts, projects, recentTopics, notes };
}

function involvedUserIds(batch: StoredMessage[], all: StoredMessage[], users: Person[]): number[] {
  const ids = new Set<number>();
  const byMsgId = new Map(all.map((message) => [message.msg_id, message]));
  for (const message of batch) {
    if (message.from_bot) continue;
    if (message.user_id) ids.add(message.user_id);
    const repliedTo = message.reply_to_msg_id ? byMsgId.get(message.reply_to_msg_id) : undefined;
    if (repliedTo?.user_id) ids.add(repliedTo.user_id);
    for (const mention of message.text.matchAll(/@([A-Za-z0-9_]{4,})/g)) {
      const user = users.find((candidate) => candidate.username?.toLowerCase() === mention[1]!.toLowerCase());
      if (user) ids.add(user.id);
    }
  }
  return [...ids];
}

/**
 * The chat's language, measured from the members' own words (the bot's commands answer in English anywhere); recent
 * chronicle and facts only help when the batch is too short.
 */
export function chatLanguageOf(data: BatchData): string | null {
  return detectLanguage(
    [...data.context, ...data.batch].filter((message) => !message.is_forward && !message.from_bot).map((message) => message.text),
    [...(data.recentTopics ?? []).map((topic) => topic.title), ...data.facts.map((fact) => fact.value)],
  );
}

function formatMessage(message: StoredMessage, users: Map<number, Person>): string {
  const author = message.user_id ? users.get(message.user_id) : undefined;
  const who = message.from_bot ? "Waggle (bot)" : author ? `${author.display_name} (u${author.id})` : "unknown";
  const reply = message.reply_to_bot ? " ↩bot" : message.reply_to_msg_id ? ` ↩${message.reply_to_msg_id}` : "";
  const forward = message.is_forward ? ` [forwarded${message.forward_source ? ` from ${message.forward_source}` : ""}]` : "";
  const media = message.media_type ? ` [${message.media_type}]` : "";
  // Whitespace is collapsed first, so a number split by a line break is masked whole.
  const text = truncate(maskPersonalData(message.text.replace(/\s+/g, " ").trim()), message.is_forward ? 300 : 1200);
  return `[${message.msg_id}] ${who}${reply}${forward}${media}${text ? `: ${text}` : ""}`;
}

export const isoDay = (date: Date, timeZone: string) => date.toLocaleDateString("en-CA", { timeZone });

/** The messages, each day opened by a line with its date, so a deadline or a forecast can be dated. */
export function messageLines(messages: StoredMessage[], users: Map<number, Person>, timeZone: string): string[] {
  const lines: string[] = [];
  let day = "";
  for (const message of messages) {
    const today = isoDay(message.sent_at, timeZone);
    if (today !== day) lines.push(`--- ${today}, ${message.sent_at.toLocaleDateString("en-US", { weekday: "long", timeZone })} ---`);
    day = today;
    lines.push(formatMessage(message, users));
  }
  return lines;
}

/** The context and the new messages, as both calls show them. */
export function messageBlocks(data: BatchData): string[] {
  const users = new Map(data.users.map((user) => [user.id, user]));
  const timeZone = data.timezone ?? "UTC";
  return [
    `<context>\n${messageLines(data.context, users, timeZone).join("\n") || "(none)"}\n</context>`,
    `<new_messages>\n${messageLines(data.batch, users, timeZone).join("\n")}\n</new_messages>`,
  ];
}

export function parseRef(ref: string): number | null {
  const match = /^u?(\d+)$/.exec(ref.trim());
  return match ? Number(match[1]) : null;
}

/** Message ids of the batch that a member wrote: the bot's own lines are context, never a source about anyone. */
export function memberSources(batchById: Map<number, StoredMessage>) {
  return (ids: number[], max = 3) => ids.filter((id) => batchById.has(id) && !batchById.get(id)!.from_bot).slice(0, max);
}

export const isOwner = (data: BatchData, user: Person) => user.tg_id !== null && (data.ownerTgIds ?? []).includes(user.tg_id);
