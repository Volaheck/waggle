import type { Queryable, Sql } from "./db.js";
import type { StoredMessage } from "./messages.js";
import type { Person } from "./users.js";

/** Reads the chronicle the extractor wrote. Plain SQL: bot commands never call the LLM. */
export interface ChronicleEntry {
  id: number;
  title: string;
  summary: string;
  kind: "discussion" | "project" | "link" | "news";
  msg_ids: number[];
  user_ids: number[];
  heat: number;
  importance: number;
  period_from: Date;
  period_to: Date;
}

/**
 * A topic may only point to a project of its own chat. Links that an earlier version of the
 * chronicler made across chats move to the chat's own project with that slug, or are cleared.
 * Links to imported projects (chat 0) without such a match stay: attaching the import fixes them.
 */
export async function relinkForeignTopics(sql: Queryable): Promise<number> {
  const rows = await sql`
    UPDATE chronicle c
    SET project_id = (SELECT own.id FROM projects own WHERE own.chat_id = c.chat_id AND own.slug = p.slug AND NOT own.hidden)
    FROM projects p
    WHERE p.id = c.project_id AND p.chat_id <> c.chat_id
      AND (p.chat_id <> 0 OR EXISTS (SELECT 1 FROM projects own WHERE own.chat_id = c.chat_id AND own.slug = p.slug AND NOT own.hidden))`;
  return rows.count;
}

/** How many events the chronicle shows for a period: it is a digest of the main things, not a transcript. */
export function topLimitFor(days: number): number {
  if (days <= 1) return 5;
  if (days <= 3) return 7;
  if (days <= 7) return 10;
  return 15;
}

/** The most important events since a moment: the chronicler's importance first, then how lively the thread was. */
export async function topChronicle(sql: Sql, chatId: number, since: Date, limit: number): Promise<ChronicleEntry[]> {
  return sql<ChronicleEntry[]>`
    SELECT id, title, summary, kind, msg_ids, user_ids, heat, importance, period_from, period_to
    FROM chronicle
    WHERE chat_id = ${chatId} AND period_to > ${since} AND importance >= 2
    ORDER BY importance DESC, heat DESC, period_to DESC
    LIMIT ${limit}`;
}

export interface CatchupData {
  from: Date;
  entries: ChronicleEntry[];
  totalMessages: number;
  unprocessed: { count: number; firstMsgId: number | null };
  lastRunAt: Date | null;
  mentions: StoredMessage[];
}

const MIN_CATCHUP_MESSAGES = 20;
const FALLBACK_HOURS = 24;
const MAX_LOOKBACK_HOURS = 7 * 24;

/** Builds «what I missed» (/catchup) purely from stored chronicle entries. */
export async function catchupFor(sql: Sql, chatId: number, user: Person, sinceHours?: number): Promise<CatchupData> {
  const now = Date.now();
  const floor = new Date(now - MAX_LOOKBACK_HOURS * 3_600_000);
  let from = sinceHours !== undefined ? new Date(now - sinceHours * 3_600_000) : user.last_message_at ?? new Date(now - FALLBACK_HOURS * 3_600_000);
  if (from < floor) from = floor;

  // The bot's own messages are not what the reader missed.
  const countSince = async (start: Date) =>
    (await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM messages WHERE chat_id = ${chatId} AND sent_at > ${start} AND NOT from_bot`)[0]?.count ?? 0;
  let totalMessages = await countSince(from);
  // Too little since the reader's last message: look further back, but never skip what they actually missed.
  const fallback = new Date(now - FALLBACK_HOURS * 3_600_000);
  if (sinceHours === undefined && totalMessages < MIN_CATCHUP_MESSAGES && from > fallback) {
    from = fallback;
    totalMessages = await countSince(from);
  }

  const [entries, unprocessedRows, lastRunRows, mentions] = await Promise.all([
    topChronicle(sql, chatId, from, 8),
    sql<{ count: number; first: number | null }[]>`
      SELECT count(*)::int AS count, min(msg_id) AS first FROM messages
      WHERE chat_id = ${chatId} AND extracted_at IS NULL AND sent_at > ${from} AND NOT from_bot`,
    sql<{ at: Date | null }[]>`SELECT max(finished_at) AS at FROM extraction_runs WHERE chat_id = ${chatId} AND status = 'done'`,
    // A reply whose text was cleared after the retention period is left out; one with media still shows.
    sql<StoredMessage[]>`
      SELECT m.chat_id, m.msg_id, m.user_id, m.sent_at, m.text, m.reply_to_msg_id, m.is_forward, m.forward_source, m.media_type
      FROM messages m
      LEFT JOIN messages parent ON parent.chat_id = m.chat_id AND parent.msg_id = m.reply_to_msg_id
      WHERE m.chat_id = ${chatId} AND m.sent_at > ${from} AND m.user_id IS DISTINCT FROM ${user.id} AND NOT m.from_bot
        AND (btrim(m.text) <> '' OR m.media_type IS NOT NULL)
        AND (parent.user_id = ${user.id} OR (${user.username}::text IS NOT NULL AND m.text ILIKE '%@' || ${user.username}::text || '%'))
      ORDER BY m.msg_id DESC
      LIMIT 8`,
  ]);
  return {
    from,
    entries,
    totalMessages,
    unprocessed: { count: unprocessedRows[0]?.count ?? 0, firstMsgId: unprocessedRows[0]?.first ?? null },
    lastRunAt: lastRunRows[0]?.at ?? null,
    mentions,
  };
}
