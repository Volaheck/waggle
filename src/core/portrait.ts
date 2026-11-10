import type { Sql } from "./db.js";

/**
 * A private portrait of a person's character: who they are, not what they like. Built from their own messages, in
 * their private chats (when they connected the bot to their account) and in the groups the bot was added to, and shown
 * to them alone, in their private chat with the bot. Nothing else in the bot reads it.
 *
 * Messages are read in passes into observations, each with the evidence behind it; the portrait is written from the
 * observations every few days. Message texts are deleted once read; the observations and the portrait stay until the
 * person deletes them.
 */

/** The areas observations are filed under; each is also a section of the portrait. */
export const PORTRAIT_AREAS = ["thinking", "emotions", "relationships", "communication", "drives", "self_image", "shadow", "strengths", "signals"] as const;
export type PortraitArea = (typeof PORTRAIT_AREAS)[number];

/** The portrait's sections, in the order they are shown. */
export const PORTRAIT_SECTIONS = ["core", ...PORTRAIT_AREAS, "changes", "limits"] as const;
export type PortraitSection = (typeof PORTRAIT_SECTIONS)[number];
export type PortraitSections = Partial<Record<PortraitSection, string>>;

export type Strength = "weak" | "moderate" | "strong";
export type Setting = "dm" | "group" | "both";

export interface Portrait {
  tg_id: number;
  status: "on" | "paused";
  sections: PortraitSections | null;
  written_at: Date | null;
  written_from: number;
  group_cursor: Date;
  read_at: Date | null;
  read_dm: number;
  read_group: number;
  rebuild_asked_at: Date | null;
  spend_month: Date;
  spend_usd: string;
  created_at: Date;
}

export interface Observation {
  id: number;
  area: PortraitArea;
  text: string;
  quote: string | null;
  strength: Strength;
  setting: Setting;
  sources: number;
  seen_from: Date;
  seen_to: Date;
}

export interface DmLine {
  chat_id: number;
  msg_id: number;
  from_subject: boolean;
  speaker: string;
  text: string;
  sent_at: Date;
}

/** A group message: the person's own, or one around it that it answers or follows. */
export interface GroupLine {
  chat_id: number;
  chat_title: string;
  msg_id: number;
  from_subject: boolean;
  speaker: string;
  text: string;
  sent_at: Date;
}

/** Private-chat lines that waited this long unread (the caps were used up) are deleted anyway. */
const UNREAD_KEEP_DAYS = 14;
/** The oldest observations go past this many per person: the portrait has long carried what they said. */
const OBSERVATIONS_KEPT = 1500;
/** Messages around one of the person's own in a group, for what it answers. */
const GROUP_CONTEXT_BEFORE = 2;

export async function portraitOf(sql: Sql, tgId: number): Promise<Portrait | undefined> {
  const [row] = await sql<Portrait[]>`SELECT * FROM portraits WHERE tg_id = ${tgId}`;
  return row;
}

/** Starts (or resumes) collecting; true when the portrait is new. */
export async function startPortrait(sql: Sql, tgId: number): Promise<boolean> {
  const [row] = await sql<{ created: boolean }[]>`
    INSERT INTO portraits (tg_id) VALUES (${tgId})
    ON CONFLICT (tg_id) DO UPDATE SET status = 'on'
    RETURNING (xmax = 0) AS created`;
  return row?.created ?? false;
}

/** Pausing also drops the private-chat lines not read yet: nothing is kept for a portrait that is not collecting. */
export async function pausePortrait(sql: Sql, tgId: number): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`UPDATE portraits SET status = 'paused', rebuild_asked_at = NULL WHERE tg_id = ${tgId}`;
    await tx`DELETE FROM portrait_lines WHERE tg_id = ${tgId}`;
  });
}

/** The portrait, its observations and any unread lines. */
export async function deletePortrait(sql: Sql, tgId: number): Promise<boolean> {
  const deleted = await sql`DELETE FROM portraits WHERE tg_id = ${tgId}`;
  return deleted.count > 0;
}

/** Keeps a line of a private chat for a person whose portrait is collecting; an edit replaces the text. */
export async function savePortraitLine(sql: Sql, tgId: number, line: DmLine): Promise<boolean> {
  const saved = await sql`
    INSERT INTO portrait_lines (tg_id, chat_id, msg_id, from_subject, speaker, text, sent_at)
    SELECT ${tgId}, ${line.chat_id}, ${line.msg_id}, ${line.from_subject}, ${line.speaker}, ${line.text}, ${line.sent_at}
    WHERE EXISTS (SELECT 1 FROM portraits WHERE tg_id = ${tgId} AND status = 'on')
    ON CONFLICT (tg_id, chat_id, msg_id) DO UPDATE SET text = excluded.text`;
  return saved.count > 0;
}

export interface ReadyPerson {
  tg_id: number;
  own_lines: number;
  oldest: Date | null;
  rebuild: boolean;
}

/** Everyone collecting, with how many of their own messages wait and since when; and whether they asked for a rebuild. */
export async function peopleWaiting(sql: Sql): Promise<ReadyPerson[]> {
  return sql<ReadyPerson[]>`
    SELECT p.tg_id,
           (dm.n + grp.n)::int AS own_lines,
           CASE WHEN dm.oldest IS NULL THEN grp.oldest WHEN grp.oldest IS NULL THEN dm.oldest ELSE least(dm.oldest, grp.oldest) END AS oldest,
           (p.rebuild_asked_at IS NOT NULL) AS rebuild
    FROM portraits p
    CROSS JOIN LATERAL (
      SELECT count(*) AS n, min(sent_at) AS oldest FROM portrait_lines l WHERE l.tg_id = p.tg_id AND l.from_subject
    ) dm
    CROSS JOIN LATERAL (
      SELECT count(*) AS n, min(m.sent_at) AS oldest
      FROM users u
      JOIN messages m ON m.user_id = u.id
      JOIN chats c ON c.id = m.chat_id AND c.status = 'approved'
      JOIN members mb ON mb.chat_id = m.chat_id AND mb.user_id = u.id AND NOT mb.opted_out
      WHERE u.tg_id = p.tg_id AND m.sent_at > p.group_cursor AND m.text <> '' AND NOT m.from_bot
    ) grp
    WHERE p.status = 'on'
    ORDER BY p.tg_id`;
}

/** The oldest private-chat lines, both sides, in order. */
export async function dmLines(sql: Sql, tgId: number, limit: number): Promise<DmLine[]> {
  return sql<DmLine[]>`
    SELECT chat_id, msg_id, from_subject, speaker, text, sent_at FROM portrait_lines
    WHERE tg_id = ${tgId} ORDER BY sent_at, chat_id, msg_id LIMIT ${limit}`;
}

export async function dropDmLines(sql: Sql, tgId: number, lines: Pick<DmLine, "chat_id" | "msg_id">[]): Promise<void> {
  if (lines.length === 0) return;
  await sql`
    DELETE FROM portrait_lines l USING unnest(${lines.map((line) => line.chat_id)}::bigint[], ${lines.map((line) => line.msg_id)}::bigint[]) AS gone(chat_id, msg_id)
    WHERE l.tg_id = ${tgId} AND l.chat_id = gone.chat_id AND l.msg_id = gone.msg_id`;
}

/**
 * The person's own group messages since the cursor (from approved chats where they are not opted out), oldest first,
 * with the messages right before each and the one it replies to. Messages of members who opted out are left out.
 */
export async function groupLines(sql: Sql, tgId: number, since: Date, limit: number): Promise<{ own: GroupLine[]; around: GroupLine[] }> {
  const own = await sql<(GroupLine & { reply_to_msg_id: number | null })[]>`
    SELECT m.chat_id, coalesce(c.title, 'group') AS chat_title, m.msg_id, true AS from_subject, 'me' AS speaker, m.text, m.sent_at, m.reply_to_msg_id
    FROM users u
    JOIN messages m ON m.user_id = u.id
    JOIN chats c ON c.id = m.chat_id AND c.status = 'approved'
    JOIN members mb ON mb.chat_id = m.chat_id AND mb.user_id = u.id AND NOT mb.opted_out
    WHERE u.tg_id = ${tgId} AND m.sent_at > ${since} AND m.text <> '' AND NOT m.from_bot
    ORDER BY m.sent_at, m.chat_id, m.msg_id
    LIMIT ${limit}`;
  if (own.length === 0) return { own: [], around: [] };
  const around = await sql<GroupLine[]>`
    SELECT DISTINCT ON (ctx.chat_id, ctx.msg_id) ctx.chat_id, ctx.chat_title, ctx.msg_id, ctx.from_subject, ctx.speaker, ctx.text, ctx.sent_at
    FROM unnest(${own.map((line) => line.chat_id)}::bigint[], ${own.map((line) => line.msg_id)}::bigint[], ${own.map((line) => line.reply_to_msg_id ?? 0)}::bigint[])
      AS mine(chat_id, msg_id, reply_to)
    CROSS JOIN LATERAL (
      SELECT m.chat_id, coalesce(c.title, 'group') AS chat_title, m.msg_id, (u.tg_id IS NOT DISTINCT FROM ${tgId}) AS from_subject,
             CASE WHEN m.from_bot THEN 'bot' WHEN u.tg_id = ${tgId} THEN 'me' ELSE coalesce(u.display_name, 'someone') END AS speaker,
             m.text, m.sent_at
      FROM messages m
      JOIN chats c ON c.id = m.chat_id
      LEFT JOIN users u ON u.id = m.user_id
      LEFT JOIN members mb ON mb.chat_id = m.chat_id AND mb.user_id = m.user_id
      WHERE m.chat_id = mine.chat_id AND m.text <> '' AND NOT coalesce(mb.opted_out, false)
        AND (m.msg_id = mine.reply_to OR m.msg_id IN (
          SELECT before.msg_id FROM messages before
          WHERE before.chat_id = mine.chat_id AND before.msg_id < mine.msg_id
          ORDER BY before.msg_id DESC LIMIT ${GROUP_CONTEXT_BEFORE}))
    ) ctx
    ORDER BY ctx.chat_id, ctx.msg_id`;
  return { own: own.map(({ reply_to_msg_id: _reply, ...line }) => line), around };
}

/** After a pass: the group cursor moves past what was read, and the counters grow. */
export async function markPortraitRead(sql: Sql, tgId: number, read: { groupUpTo: Date | null; dm: number; group: number }): Promise<void> {
  await sql`
    UPDATE portraits SET
      group_cursor = greatest(group_cursor, coalesce(${read.groupUpTo}::timestamptz, group_cursor)),
      read_dm = read_dm + ${read.dm}, read_group = read_group + ${read.group}, read_at = now()
    WHERE tg_id = ${tgId}`;
}

export interface NewObservation {
  area: PortraitArea;
  text: string;
  quote: string | null;
  strength: Strength;
  setting: Setting;
  sources: number;
  seen_from: Date;
  seen_to: Date;
}

export async function addObservations(sql: Sql, tgId: number, observations: NewObservation[]): Promise<number> {
  if (observations.length === 0) return 0;
  await sql`
    INSERT INTO portrait_observations ${sql(
      observations.map((observation) => ({ tg_id: tgId, ...observation })),
      "tg_id",
      "area",
      "text",
      "quote",
      "strength",
      "setting",
      "sources",
      "seen_from",
      "seen_to",
    )}`;
  await sql`
    DELETE FROM portrait_observations WHERE tg_id = ${tgId} AND id < (
      SELECT id FROM portrait_observations WHERE tg_id = ${tgId} ORDER BY id DESC OFFSET ${OBSERVATIONS_KEPT - 1} LIMIT 1)`;
  return observations.length;
}

/** The latest observations, oldest first. */
export async function latestObservations(sql: Sql, tgId: number, limit: number): Promise<Observation[]> {
  const rows = await sql<Observation[]>`
    SELECT id, area, text, quote, strength, setting, sources, seen_from, seen_to FROM portrait_observations
    WHERE tg_id = ${tgId} ORDER BY id DESC LIMIT ${limit}`;
  return rows.reverse();
}

export async function observationCount(sql: Sql, tgId: number): Promise<number> {
  const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM portrait_observations WHERE tg_id = ${tgId}`;
  return row?.n ?? 0;
}

export async function savePortrait(sql: Sql, tgId: number, sections: PortraitSections, writtenFrom: number): Promise<void> {
  await sql`
    UPDATE portraits SET sections = ${sql.json(sections)}, written_at = now(), written_from = ${writtenFrom}, rebuild_asked_at = NULL
    WHERE tg_id = ${tgId}`;
}

export async function askRebuild(sql: Sql, tgId: number): Promise<void> {
  await sql`UPDATE portraits SET rebuild_asked_at = now() WHERE tg_id = ${tgId} AND status = 'on'`;
}

export async function clearRebuild(sql: Sql, tgId: number): Promise<void> {
  await sql`UPDATE portraits SET rebuild_asked_at = NULL WHERE tg_id = ${tgId}`;
}

/** Adds to the person's spending this month, starting over in a new month. */
export async function addPortraitSpend(sql: Sql, tgId: number, usd: number): Promise<void> {
  await sql`
    UPDATE portraits SET
      spend_usd = CASE WHEN spend_month = date_trunc('month', now())::date THEN spend_usd ELSE 0 END + ${usd},
      spend_month = date_trunc('month', now())::date
    WHERE tg_id = ${tgId}`;
}

export async function personSpendUsd(sql: Sql, tgId: number): Promise<number> {
  const [row] = await sql<{ usd: string }[]>`
    SELECT CASE WHEN spend_month = date_trunc('month', now())::date THEN spend_usd ELSE 0 END::text AS usd FROM portraits WHERE tg_id = ${tgId}`;
  return Number(row?.usd ?? 0);
}

/** This month's spending on portraits for everyone. */
export async function portraitsSpendUsd(sql: Sql, purposes: readonly string[]): Promise<number> {
  const [row] = await sql<{ total: string | null }[]>`
    SELECT sum(cost_usd)::text AS total FROM llm_usage WHERE at >= date_trunc('month', now()) AND purpose = ANY(${purposes as string[]})`;
  return Number(row?.total ?? 0);
}

export async function clearStalePortraitLines(sql: Sql): Promise<number> {
  const cleared = await sql`DELETE FROM portrait_lines WHERE sent_at < now() - make_interval(days => ${UNREAD_KEEP_DAYS})`;
  return cleared.count;
}
