import type { Fragment } from "postgres";
import type { Queryable, Sql } from "./db.js";
import { hasForbiddenTopic, normalizeValue } from "./text.js";

/**
 * The hidden layer: what only the bot and its owners see. Members never get these, not in the Mini App, not in
 * /whatyouknow; the bot uses them to answer people with their own history, and owners list and delete them (/notes).
 */

export const NOTE_KINDS = ["correction", "claim", "stance", "bit", "bout", "bait", "about_bot", "prediction"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export const NOTE_STATUSES = ["open", "done", "dropped", "right", "wrong"] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];

/** The `about` of an about_bot note in which someone objects to being recorded or processed by the bot. */
export const CONSENT = "consent";

export interface Note {
  id: number;
  chat_id: number;
  user_id: number | null;
  kind: NoteKind;
  about: string | null;
  value: string;
  status: NoteStatus | null;
  due_at: Date | null;
  user_ids: number[];
  topic_id: number | null;
  confidence: number;
  source_msg_ids: number[];
  said_at: Date | null;
  superseded_by: number | null;
  created_at: Date;
  updated_at: Date;
}

const MAX_VALUE_LENGTH = 300;
const MAX_ABOUT_LENGTH = 80;
const MAX_SOURCES = 10;
/** A deadline or a forecast further away than this is not one anybody will check. */
const MAX_DUE_YEARS = 10;

/** The statuses a kind takes, the first being the one it starts with; the other kinds have none. */
const KIND_STATUSES: Partial<Record<NoteKind, NoteStatus[]>> = {
  claim: ["open", "done", "dropped"],
  prediction: ["open", "right", "wrong"],
};

/** A masked phone, card or secret in a note means it is about private data, which no note keeps. */
const MASKED = /\[(?:phone|email|card|account|number|secret|person|birthdate)\]/;

const DAY_MS = 86_400_000;

/** The status as given when the kind takes it, else null. */
function validStatus(kind: NoteKind, status: NoteStatus | null): NoteStatus | null {
  return status !== null && KIND_STATUSES[kind]?.includes(status) ? status : null;
}

/** «2026-12-01» when it is a real date no earlier than the day before the note was said, within MAX_DUE_YEARS; null otherwise. */
export function dueDate(raw: string | null, saidAt: Date): string | null {
  const match = raw ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim()) : null;
  if (!match) return null;
  const date = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (new Date(date).toISOString().slice(0, 10) !== match[0]) return null;
  const saidDay = Date.UTC(saidAt.getUTCFullYear(), saidAt.getUTCMonth(), saidAt.getUTCDate());
  return date >= saidDay - DAY_MS && date <= saidDay + MAX_DUE_YEARS * 365.25 * DAY_MS ? match[0] : null;
}

export interface NoteInput {
  chatId: number;
  userId: number | null;
  kind: NoteKind;
  about: string | null;
  value: string;
  status: NoteStatus | null;
  dueAt: string | null;
  userIds: number[];
  topicId: number | null;
  confidence: number;
  sourceMsgIds: number[];
  saidAt: Date;
  /** A current note of the same person and kind that this one updates: it is superseded, or rewritten in place when the wording is the same. */
  replaces: number | null;
}

export type SaveNoteOutcome = "added" | "updated" | "skipped";

/** Two lists of message ids as one, the newest MAX_SOURCES kept. */
const unionIds = (tx: Queryable, a: string, b: Fragment | string) =>
  tx`(SELECT coalesce(array_agg(id ORDER BY id), '{}') FROM (
        SELECT DISTINCT id FROM unnest(${tx.unsafe(a)} || ${typeof b === "string" ? tx.unsafe(b) : b}) AS listed(id) ORDER BY id DESC LIMIT ${MAX_SOURCES}
      ) AS latest)`;

/**
 * Stores a note, or adds to the one that already says the same (by value_norm). Forbidden topics and private data
 * never get in, and nothing is kept about a member who opted out, who is also left out of everyone else's notes.
 */
export async function saveNote(tx: Queryable, input: NoteInput): Promise<SaveNoteOutcome> {
  const value = input.value.replace(/\s+/g, " ").trim().slice(0, MAX_VALUE_LENGTH);
  const valueNorm = normalizeValue(value);
  const about = input.about?.replace(/\s+/g, " ").trim().slice(0, MAX_ABOUT_LENGTH) || null;
  if (!valueNorm || hasForbiddenTopic(`${about ?? ""} ${value}`) || MASKED.test(`${about ?? ""} ${value}`)) return "skipped";

  const involved = [...new Set([...(input.userId !== null ? [input.userId] : []), ...input.userIds])];
  // Read now rather than trusted from the batch: someone may have opted out while the model was answering.
  const present = involved.length
    ? (await tx<{ user_id: number }[]>`SELECT user_id FROM members WHERE chat_id = ${input.chatId} AND user_id = ANY(${involved}) AND NOT opted_out`).map((row) => row.user_id)
    : [];
  if (input.userId !== null && !present.includes(input.userId)) return "skipped";
  const userIds = involved.filter((id) => present.includes(id));
  // A status the kind does not take changes nothing; a new claim or prediction starts open.
  const status = validStatus(input.kind, input.status);
  const initialStatus = status ?? KIND_STATUSES[input.kind]?.[0] ?? null;
  const dueAt = KIND_STATUSES[input.kind] ? dueDate(input.dueAt, input.saidAt) : null;
  const confidence = Math.min(1, Math.max(0, input.confidence));
  const sources = [...new Set(input.sourceMsgIds)].slice(0, MAX_SOURCES);

  const [replaced] =
    input.replaces !== null
      ? await tx<Note[]>`
          SELECT * FROM notes
          WHERE id = ${input.replaces} AND chat_id = ${input.chatId} AND kind = ${input.kind}
            AND coalesce(user_id, 0) = ${input.userId ?? 0} AND superseded_by IS NULL
          FOR UPDATE`
      : [];
  if (replaced && normalizeValue(replaced.value) === valueNorm) {
    await tx`
      UPDATE notes SET
        status = coalesce(${status}, status),
        due_at = coalesce(${dueAt}::date, due_at),
        about = coalesce(${about}, about),
        user_ids = (SELECT coalesce(array_agg(DISTINCT id), '{}') FROM unnest(user_ids || ${userIds}::int[]) AS listed(id)),
        source_msg_ids = ${unionIds(tx, "source_msg_ids", tx`${sources}::bigint[]`)},
        said_at = greatest(said_at, ${input.saidAt}),
        confidence = greatest(confidence, ${confidence}),
        updated_at = now()
      WHERE id = ${replaced.id}`;
    return "updated";
  }

  // The same words as an earlier note that was superseded make it current again.
  const [row] = await tx<{ id: number; inserted: boolean }[]>`
    INSERT INTO notes (chat_id, user_id, kind, about, value, value_norm, status, due_at, user_ids, topic_id, confidence, source_msg_ids, said_at)
    VALUES (${input.chatId}, ${input.userId}, ${input.kind}, ${about}, ${value}, ${valueNorm}, ${initialStatus}, ${dueAt}::date, ${userIds}::int[],
            ${input.topicId}, ${confidence}, ${sources}::bigint[], ${input.saidAt})
    ON CONFLICT (chat_id, (coalesce(user_id, 0)), kind, value_norm) DO UPDATE SET
      status = coalesce(${status}, notes.status),
      due_at = coalesce(excluded.due_at, notes.due_at),
      about = coalesce(notes.about, excluded.about),
      user_ids = (SELECT coalesce(array_agg(DISTINCT id), '{}') FROM unnest(notes.user_ids || excluded.user_ids) AS listed(id)),
      topic_id = coalesce(excluded.topic_id, notes.topic_id),
      source_msg_ids = ${unionIds(tx, "notes.source_msg_ids", "excluded.source_msg_ids")},
      said_at = greatest(notes.said_at, excluded.said_at),
      confidence = greatest(notes.confidence, excluded.confidence),
      superseded_by = NULL,
      updated_at = now()
    RETURNING id, (xmax = 0) AS inserted`;
  if (replaced && replaced.id !== row!.id) await tx`UPDATE notes SET superseded_by = ${row!.id}, updated_at = now() WHERE id = ${replaced.id}`;
  return row!.inserted ? "added" : "updated";
}

/** A note with the names of the people in it, for the owners' list. */
export interface ListedNote extends Note {
  display_name: string | null;
  username: string | null;
}

/** The chat's current notes, newest first; with `userId`, those about that person or with them in it. */
export async function chatNotes(sql: Sql, chatId: number, options: { userId?: number; limit?: number } = {}): Promise<{ notes: ListedNote[]; total: number }> {
  const userId = options.userId ?? null;
  const [notes, [count]] = await Promise.all([
    sql<ListedNote[]>`
      SELECT n.*, u.display_name, u.username
      FROM notes n LEFT JOIN users u ON u.id = n.user_id
      WHERE n.chat_id = ${chatId} AND n.superseded_by IS NULL AND (${userId}::int IS NULL OR n.user_id = ${userId}::int OR ${userId}::int = ANY(n.user_ids))
      ORDER BY coalesce(n.said_at, n.created_at) DESC, n.id DESC
      LIMIT ${options.limit ?? 30}`,
    sql<{ total: number }[]>`
      SELECT count(*)::int AS total FROM notes
      WHERE chat_id = ${chatId} AND superseded_by IS NULL AND (${userId}::int IS NULL OR user_id = ${userId}::int OR ${userId}::int = ANY(user_ids))`,
  ]);
  return { notes, total: count?.total ?? 0 };
}

/** Deletes a note together with the earlier versions it superseded, which would otherwise come back. */
export async function deleteNote(sql: Sql, noteId: number): Promise<{ chat_id: number } | undefined> {
  const [root] = await sql<{ chat_id: number }[]>`SELECT chat_id FROM notes WHERE id = ${noteId}`;
  if (!root) return undefined;
  await sql`
    WITH RECURSIVE history AS (
      SELECT id FROM notes WHERE id = ${noteId}
      UNION
      SELECT n.id FROM notes n JOIN history h ON n.superseded_by = h.id
    )
    DELETE FROM notes WHERE id IN (SELECT id FROM history)`;
  return root;
}

/** /forgetme and opting out: the person's notes go, and they are taken out of everyone else's (in one chat, or everywhere). */
export async function forgetNotes(tx: Queryable, userId: number, chatId: number | null): Promise<void> {
  await tx`DELETE FROM notes WHERE user_id = ${userId} AND (${chatId}::bigint IS NULL OR chat_id = ${chatId}::bigint)`;
  await tx`
    UPDATE notes SET user_ids = array_remove(user_ids, ${userId}::int), updated_at = now()
    WHERE ${userId}::int = ANY(user_ids) AND (${chatId}::bigint IS NULL OR chat_id = ${chatId}::bigint)`;
}

/** Nothing stays about a member of the chat who opted out, whichever chat or card a note came from. */
export async function dropOptedOutNotes(tx: Queryable, chatId: number): Promise<void> {
  await tx`DELETE FROM notes n USING members m WHERE n.chat_id = ${chatId} AND m.chat_id = ${chatId} AND m.user_id = n.user_id AND m.opted_out`;
  await tx`
    UPDATE notes n SET user_ids = coalesce((
      SELECT array_agg(listed.id ORDER BY listed.position) FROM unnest(n.user_ids) WITH ORDINALITY AS listed(id, position)
      WHERE NOT EXISTS (SELECT 1 FROM members m WHERE m.chat_id = n.chat_id AND m.user_id = listed.id AND m.opted_out)), '{}')
    WHERE n.chat_id = ${chatId} AND EXISTS (SELECT 1 FROM members m WHERE m.chat_id = n.chat_id AND m.user_id = ANY(n.user_ids) AND m.opted_out)`;
}

/**
 * Moves a chat's notes to another chat id (a supergroup upgrade, attaching imported history). `sourceIds` maps the
 * source message ids the way the messages moved. A note the target already has absorbs the moving copy, and a note
 * superseded by that copy leads to the kept one.
 */
export async function moveNotes(tx: Queryable, from: number, to: number, sourceIds: (column: string) => Fragment = (column) => tx.unsafe(column)): Promise<void> {
  const twin = () => tx`kept.chat_id = ${to} AND coalesce(kept.user_id, 0) = coalesce(moving.user_id, 0) AND kept.kind = moving.kind AND kept.value_norm = moving.value_norm`;
  await tx`
    UPDATE notes kept SET
      source_msg_ids = ${unionIds(tx, "kept.source_msg_ids", sourceIds("moving.source_msg_ids"))},
      user_ids = (SELECT coalesce(array_agg(DISTINCT id), '{}') FROM unnest(kept.user_ids || moving.user_ids) AS listed(id)),
      said_at = greatest(kept.said_at, moving.said_at),
      confidence = greatest(kept.confidence, moving.confidence),
      updated_at = now()
    FROM notes moving
    WHERE moving.chat_id = ${from} AND ${twin()}`;
  await tx`
    UPDATE notes earlier SET superseded_by = kept.id
    FROM notes moving JOIN notes kept ON ${twin()}
    WHERE moving.chat_id = ${from} AND earlier.superseded_by = moving.id`;
  await tx`
    UPDATE notes moving SET chat_id = ${to}, source_msg_ids = ${sourceIds("moving.source_msg_ids")}
    WHERE moving.chat_id = ${from} AND NOT EXISTS (SELECT 1 FROM notes kept WHERE ${twin()})`;
  await tx`DELETE FROM notes WHERE chat_id = ${from}`;
  await dropOptedOutNotes(tx, to);
}

/**
 * Linking a card to an account: the card's notes become the account's (a note the account already has absorbs the
 * card's copy), the card is replaced by the account in everyone's notes, and an opt-out on either side wins.
 */
export async function moveNotesToUser(tx: Queryable, seedUserId: number, intoUserId: number): Promise<void> {
  const twin = () => tx`kept.chat_id = card.chat_id AND kept.user_id = ${intoUserId} AND kept.kind = card.kind AND kept.value_norm = card.value_norm`;
  await tx`
    UPDATE notes earlier SET superseded_by = kept.id
    FROM notes card JOIN notes kept ON ${twin()}
    WHERE card.user_id = ${seedUserId} AND earlier.superseded_by = card.id`;
  await tx`
    UPDATE notes card SET user_id = ${intoUserId}
    WHERE card.user_id = ${seedUserId} AND NOT EXISTS (SELECT 1 FROM notes kept WHERE ${twin()})`;
  await tx`DELETE FROM notes WHERE user_id = ${seedUserId}`;
  await tx`
    UPDATE notes SET user_ids = (
      SELECT coalesce(array_agg(id ORDER BY first_position), '{}')
      FROM (SELECT id, min(position) AS first_position
            FROM unnest(array_replace(user_ids, ${seedUserId}::int, ${intoUserId}::int)) WITH ORDINALITY AS listed(id, position)
            GROUP BY id) AS people)
    WHERE ${seedUserId}::int = ANY(user_ids)`;
  const chats = await tx<{ chat_id: number }[]>`SELECT chat_id FROM members WHERE user_id = ${intoUserId} AND opted_out`;
  for (const { chat_id: chatId } of chats) await dropOptedOutNotes(tx, chatId);
}

export interface Objector {
  user_id: number;
  display_name: string;
  username: string | null;
}

/** What the owners are told about an objection to being recorded: who, where, and what the person can do about it. */
export function consentObjectionText(objectors: Objector[], chatTitle: string): string {
  const who = objectors.map((person) => `${person.display_name}${person.username ? ` (@${person.username})` : ""}`).join(", ");
  return `🔒 ${who} objected in “${chatTitle}” to being recorded or processed by the bot. They can erase everything it knows about them with /forgetme, or stop it collecting about them in that chat in /me → 🔒 Privacy.`;
}

/** People whose first objection to being recorded in this chat was noted at `since` or later. */
export async function consentObjectionsSince(sql: Queryable, chatId: number, since: Date): Promise<Objector[]> {
  return sql<Objector[]>`
    SELECT u.id AS user_id, u.display_name, u.username
    FROM notes n JOIN users u ON u.id = n.user_id
    WHERE n.chat_id = ${chatId} AND n.kind = 'about_bot' AND n.about = ${CONSENT}
    GROUP BY u.id
    HAVING min(n.created_at) >= ${since}
    ORDER BY u.display_name`;
}
