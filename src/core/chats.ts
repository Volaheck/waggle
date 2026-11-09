import type { TransactionSql } from "postgres";
import { moveAliases } from "./aliases.js";
import { relinkForeignTopics } from "./chronicle.js";
import type { Sql } from "./db.js";
import { isSameFact } from "./facts.js";
import { mergeSeedUser } from "./merge.js";
import { moveNotes } from "./notes.js";
import { moveProjectAliases, projectForSlug } from "./projects.js";
import { normalizeUrl } from "./text.js";

export type ChatStatus = "pending" | "approved" | "rejected" | "left";

export interface Chat {
  id: number;
  title: string | null;
  status: ChatStatus;
  added_by: number | null;
  decided_by: number | null;
  decided_at: Date | null;
  monthly_budget_usd: string | null;
  created_at: Date;
  /** Set while the chronicler is paused here (repeated refusals by the model); messages are still saved. */
  chronicle_paused_at: Date | null;
  chronicle_pause_reason: string | null;
  /** When an owner last resumed it: refusals before that no longer count. */
  chronicle_resumed_at: Date | null;
  /** Whether the bot may speak up uninvited here; an owner turns it off. */
  interjections: boolean;
}

/** Rows imported before multi-chat support carry this chat id until an owner attaches them. */
export const LEGACY_CHAT_ID = 0;

export async function getChat(sql: Sql, chatId: number): Promise<Chat | undefined> {
  const [chat] = await sql<Chat[]>`SELECT * FROM chats WHERE id = ${chatId}`;
  return chat;
}

/** The bot was added to a group: remember it; a new chat waits for an owner's decision. */
export async function registerChat(sql: Sql, chatId: number, title: string | null, addedBy: number | null): Promise<Chat> {
  const [chat] = await sql<Chat[]>`
    INSERT INTO chats (id, title, added_by) VALUES (${chatId}, ${title}, ${addedBy})
    ON CONFLICT (id) DO UPDATE
    SET title = coalesce(excluded.title, chats.title),
        status = CASE WHEN chats.status = 'left' THEN 'pending' ELSE chats.status END,
        added_by = CASE WHEN chats.status = 'left' THEN excluded.added_by ELSE chats.added_by END
    RETURNING *`;
  return chat!;
}

export async function setChatStatus(sql: Sql, chatId: number, status: ChatStatus, decidedBy: number | null): Promise<Chat | undefined> {
  const [chat] = await sql<Chat[]>`
    UPDATE chats SET status = ${status}, decided_by = coalesce(${decidedBy}, decided_by), decided_at = CASE WHEN ${decidedBy}::bigint IS NULL THEN decided_at ELSE now() END
    WHERE id = ${chatId}
    RETURNING *`;
  return chat;
}

/** Pauses the chronicler in a chat; false when it was paused already. */
export async function pauseChronicle(sql: Sql, chatId: number, reason: string): Promise<boolean> {
  const paused = await sql`
    UPDATE chats SET chronicle_paused_at = now(), chronicle_pause_reason = ${reason}
    WHERE id = ${chatId} AND chronicle_paused_at IS NULL`;
  return paused.count > 0;
}

/** Resumes the chronicler in a chat; false when it was not paused. */
export async function resumeChronicle(sql: Sql, chatId: number): Promise<boolean> {
  const resumed = await sql`
    UPDATE chats SET chronicle_paused_at = NULL, chronicle_pause_reason = NULL, chronicle_resumed_at = now()
    WHERE id = ${chatId} AND chronicle_paused_at IS NOT NULL`;
  return resumed.count > 0;
}

/** An owner lets the bot speak up uninvited in a chat, or stops it; undefined for an unknown chat. */
export async function setInterjections(sql: Sql, chatId: number, on: boolean): Promise<Chat | undefined> {
  const [chat] = await sql<Chat[]>`UPDATE chats SET interjections = ${on} WHERE id = ${chatId} RETURNING *`;
  return chat;
}

export async function isApproved(sql: Sql, chatId: number): Promise<boolean> {
  const [row] = await sql<{ ok: boolean }[]>`SELECT status = 'approved' AS ok FROM chats WHERE id = ${chatId}`;
  return Boolean(row?.ok);
}

export async function approvedChats(sql: Sql): Promise<Chat[]> {
  return sql<Chat[]>`SELECT * FROM chats WHERE status = 'approved' ORDER BY created_at`;
}

export async function allChats(sql: Sql): Promise<Chat[]> {
  return sql<Chat[]>`SELECT * FROM chats ORDER BY status = 'pending' DESC, created_at DESC`;
}

/** Approved chats where this person is a current member, most active first. */
export async function chatsOfUser(sql: Sql, userId: number): Promise<Chat[]> {
  return sql<Chat[]>`
    SELECT c.* FROM chats c JOIN members m ON m.chat_id = c.id
    WHERE m.user_id = ${userId} AND m.left_at IS NULL AND c.status = 'approved'
    ORDER BY m.last_message_at DESC NULLS LAST, c.created_at`;
}

export async function setCurrentChat(sql: Sql, userId: number, chatId: number): Promise<void> {
  await sql`UPDATE users SET current_chat_id = ${chatId} WHERE id = ${userId}`;
}

export interface LegacyStats {
  messages: number;
  members: number;
  projects: number;
  topics: number;
}

export async function legacyStats(sql: Sql): Promise<LegacyStats> {
  const [row] = await sql<LegacyStats[]>`
    SELECT (SELECT count(*)::int FROM messages WHERE chat_id = ${LEGACY_CHAT_ID}) AS messages,
           (SELECT count(*)::int FROM members WHERE chat_id = ${LEGACY_CHAT_ID}) AS members,
           (SELECT count(*)::int FROM projects WHERE chat_id = ${LEGACY_CHAT_ID}) AS projects,
           (SELECT count(*)::int FROM chronicle WHERE chat_id = ${LEGACY_CHAT_ID}) AS topics`;
  return row!;
}

export interface AttachStats extends LegacyStats {
  /** Imported projects folded into a project the chat already had (counted in `projects` too). */
  projectsMerged: number;
  /** Imported cards linked to the account of a person who wrote in the chat before the import was attached. */
  cardsLinked: number;
}

/**
 * Moves imported history (chat_id = 0) into a real chat. Whatever collides with the chat's own data
 * is merged, never dropped: a project the chat already has receives the imported authors, votes,
 * signals and topics; of two copies of a fact the person's own word wins (a manual or hidden fact
 * over the chronicler's). A fact removed as wrong on either side stays removed, and nothing is
 * imported about members who opted out on either side. Returns what was actually moved.
 */
export async function attachLegacyData(sql: Sql, chatId: number, actorUserId?: number): Promise<AttachStats> {
  const moved = await sql.begin(async (tx) => {
    const legacyMembers = (await tx<{ user_id: number }[]>`SELECT user_id FROM members WHERE chat_id = ${LEGACY_CHAT_ID}`).map((row) => row.user_id);
    const members = await attachMembers(tx, chatId);
    const messages = (
      await tx`
        UPDATE messages m SET chat_id = ${chatId}
        WHERE m.chat_id = ${LEGACY_CHAT_ID} AND NOT EXISTS (SELECT 1 FROM messages x WHERE x.chat_id = ${chatId} AND x.msg_id = m.msg_id)`
    ).count;
    // Before the projects, so an imported project merged into the chat's own takes its aliases along.
    await moveAliases(tx, LEGACY_CHAT_ID, chatId);
    const projects = await attachProjects(tx, chatId, actorUserId ?? null);
    // Notes on how someone who opted out uses projects go too, as when they opt out themselves.
    await tx`
      DELETE FROM project_signals s USING projects p, members m
      WHERE s.project_id = p.id AND p.chat_id = ${chatId} AND m.chat_id = ${chatId} AND m.user_id = s.user_id AND m.opted_out`;
    await attachFacts(tx, chatId);
    // Imported messages keep their ids, and nothing stays about someone who opted out on either side.
    await moveNotes(tx, LEGACY_CHAT_ID, chatId);
    const topics = (await tx`UPDATE chronicle SET chat_id = ${chatId} WHERE chat_id = ${LEGACY_CHAT_ID}`).count;
    await tx`UPDATE extraction_runs SET chat_id = ${chatId} WHERE chat_id = ${LEGACY_CHAT_ID}`;
    await tx`UPDATE llm_usage SET chat_id = ${chatId} WHERE chat_id = ${LEGACY_CHAT_ID} OR chat_id IS NULL`;
    // What is left are the imported copies of messages the chat already has.
    await tx`DELETE FROM messages WHERE chat_id = ${LEGACY_CHAT_ID}`;
    // Another chat's topics may have pointed at an imported project that now belongs to this chat.
    await relinkForeignTopics(tx);
    return { members, messages, topics, projects: projects.moved + projects.merged, projectsMerged: projects.merged, legacyMembers };
  });
  const cardsLinked = await linkImportedCards(sql, chatId, moved.legacyMembers, actorUserId);
  return { messages: moved.messages, members: moved.members, projects: moved.projects, topics: moved.topics, projectsMerged: moved.projectsMerged, cardsLinked };
}

/**
 * Imported cards join the chat. A manual tagline beats the chronicler's; opting out on either side wins,
 * and then the person's facts, rejections and tagline go, as when they opt out themselves.
 */
async function attachMembers(tx: TransactionSql, chatId: number): Promise<number> {
  const { count } = await tx`
    INSERT INTO members (chat_id, user_id, tagline, tagline_manual, opted_out, first_seen_at, last_message_at, left_at)
    SELECT ${chatId}, user_id, CASE WHEN opted_out THEN NULL ELSE tagline END, tagline_manual AND NOT opted_out, opted_out, first_seen_at, last_message_at, left_at
    FROM members WHERE chat_id = ${LEGACY_CHAT_ID}
    ON CONFLICT (chat_id, user_id) DO UPDATE SET
      tagline = CASE WHEN members.opted_out OR excluded.opted_out THEN NULL
                     WHEN members.tagline IS NULL OR (NOT members.tagline_manual AND excluded.tagline_manual AND excluded.tagline IS NOT NULL) THEN excluded.tagline
                     ELSE members.tagline END,
      tagline_manual = CASE WHEN members.opted_out OR excluded.opted_out THEN false
                     WHEN members.tagline IS NULL OR (NOT members.tagline_manual AND excluded.tagline_manual AND excluded.tagline IS NOT NULL) THEN excluded.tagline_manual
                     ELSE members.tagline_manual END,
      opted_out = members.opted_out OR excluded.opted_out,
      first_seen_at = least(members.first_seen_at, excluded.first_seen_at),
      last_message_at = greatest(members.last_message_at, excluded.last_message_at)`;
  await tx`DELETE FROM members WHERE chat_id = ${LEGACY_CHAT_ID}`;
  const optedOut = (await tx<{ user_id: number }[]>`SELECT user_id FROM members WHERE chat_id = ${chatId} AND opted_out`).map((row) => row.user_id);
  if (optedOut.length) {
    await tx`DELETE FROM facts WHERE chat_id IN (${LEGACY_CHAT_ID}, ${chatId}) AND user_id = ANY(${optedOut})`;
    await tx`DELETE FROM rejected_facts WHERE chat_id IN (${LEGACY_CHAT_ID}, ${chatId}) AND user_id = ANY(${optedOut})`;
  }
  return count;
}

interface ProjectRow {
  id: number;
  slug: string;
  name: string;
  tagline: string | null;
  status: string;
  stack: string[];
  links: { repo?: string | null; site?: string | null; other?: string[] };
  confidence: number;
  hidden: boolean;
  manual_fields: string[];
  first_seen_msg_id: number | null;
  last_activity_at: Date | null;
  source_msg_ids: number[];
}

function sameUrl(a?: string | null, b?: string | null): boolean {
  return Boolean(a && b && normalizeUrl(a)?.norm === normalizeUrl(b)?.norm);
}

/** The chat's project an imported one is about: a visible one by slug, name or link first, else the hidden one holding the slug. */
function matchingProject(candidates: ProjectRow[], imported: ProjectRow): ProjectRow | undefined {
  const name = imported.name.trim().toLowerCase();
  const visible = candidates.filter((project) => !project.hidden);
  return (
    visible.find((project) => project.slug === imported.slug) ??
    visible.find((project) => project.name.trim().toLowerCase() === name) ??
    visible.find((project) => sameUrl(project.links.repo, imported.links.repo) || sameUrl(project.links.site, imported.links.site)) ??
    candidates.find((project) => project.slug === imported.slug)
  );
}

async function attachProjects(tx: TransactionSql, chatId: number, actorUserId: number | null): Promise<{ moved: number; merged: number }> {
  const own = await tx<ProjectRow[]>`SELECT * FROM projects WHERE chat_id = ${chatId}`;
  const imported = await tx<ProjectRow[]>`SELECT * FROM projects WHERE chat_id = ${LEGACY_CHAT_ID} ORDER BY id`;
  let merged = 0;
  for (const project of imported) {
    const match = matchingProject(own, project);
    if (!match) continue;
    // A hidden slug-holder that was folded into another entry leads to that entry; one a person deleted stays the target.
    const target = match.hidden ? ((await projectForSlug(tx, chatId, match.slug)) ?? match) : match;
    await mergeImportedProject(tx, project, target.id, actorUserId);
    merged += 1;
  }
  // Every slug the chat already has was merged above, so the rest moves without a clash.
  const { count } = await tx`UPDATE projects SET chat_id = ${chatId} WHERE chat_id = ${LEGACY_CHAT_ID}`;
  return { moved: count, merged };
}

/** Like mergeProjects; where a person edited the imported project and nobody edited the chat's, the person's edit wins. */
async function mergeImportedProject(tx: TransactionSql, imported: ProjectRow, intoId: number, actorUserId: number | null): Promise<void> {
  const [into] = await tx<ProjectRow[]>`SELECT * FROM projects WHERE id = ${intoId} FOR UPDATE`;
  if (!into) throw new Error(`Project ${intoId} disappeared while the import was being attached`);
  const edited = new Set(imported.manual_fields.filter((field) => !into.manual_fields.includes(field)));
  const other = [...new Set([...(into.links.other ?? []), ...(imported.links.other ?? [])])];
  const links = { ...(edited.has("links") ? { ...into.links, ...imported.links } : { ...imported.links, ...into.links }), ...(other.length ? { other } : {}) };
  const stack = edited.has("stack") ? imported.stack : [...new Set([...into.stack, ...imported.stack])];
  const tagline = edited.has("tagline") ? imported.tagline : into.tagline ?? imported.tagline;
  const status = edited.has("status") ? imported.status : into.status;
  // Hidden by a person (not as a merged-away duplicate): the chat's copy goes too.
  const hiddenByPerson =
    imported.hidden && (await tx`SELECT 1 FROM change_log WHERE entity = 'project' AND entity_id = ${imported.id} AND op = 'hide' LIMIT 1`).length > 0;

  await tx`
    INSERT INTO project_members (project_id, user_id, role)
    SELECT ${into.id}, user_id, role FROM project_members WHERE project_id = ${imported.id}
    ON CONFLICT (project_id, user_id) DO UPDATE SET role = coalesce(project_members.role, excluded.role)`;
  await tx`
    INSERT INTO votes (project_id, user_id, created_at)
    SELECT ${into.id}, v.user_id, v.created_at FROM votes v
    WHERE v.project_id = ${imported.id}
      AND NOT EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = ${into.id} AND pm.user_id = v.user_id)
    ON CONFLICT DO NOTHING`;
  await tx`UPDATE project_signals SET project_id = ${into.id} WHERE project_id = ${imported.id}`;
  await tx`UPDATE chronicle SET project_id = ${into.id} WHERE project_id = ${imported.id}`;
  await moveProjectAliases(tx, imported.id, into.id);
  await tx`
    UPDATE projects SET
      tagline = ${tagline}, status = ${status}, stack = ${stack}, links = ${tx.json(links)},
      confidence = greatest(confidence, ${imported.confidence}),
      hidden = hidden OR ${hiddenByPerson},
      manual_fields = ${[...new Set([...into.manual_fields, ...imported.manual_fields])]},
      first_seen_msg_id = least(first_seen_msg_id, ${imported.first_seen_msg_id}::bigint),
      last_activity_at = greatest(last_activity_at, ${imported.last_activity_at}::timestamptz),
      source_msg_ids = (SELECT coalesce(array_agg(DISTINCT x), '{}') FROM unnest(source_msg_ids || ${imported.source_msg_ids}::bigint[]) AS x),
      updated_at = now()
    WHERE id = ${into.id}`;
  await tx`DELETE FROM projects WHERE id = ${imported.id}`;
  await tx`
    INSERT INTO change_log (entity, entity_id, op, before, source, actor_user_id)
    VALUES ('project', ${into.id}, 'merge', ${tx.json({ merged: imported.slug, imported: true })}, 'admin', ${actorUserId})`;
}

const PERSONAL_STATUSES = new Set(["manual", "hidden"]);

async function attachFacts(tx: TransactionSql, chatId: number): Promise<void> {
  const pairs = await tx<
    { imported_id: number; imported_status: string; imported_confidence: number; imported_sources: number[]; own_id: number; own_status: string; own_confidence: number; own_sources: number[] }[]
  >`
    SELECT l.id AS imported_id, l.status AS imported_status, l.confidence AS imported_confidence, l.source_msg_ids AS imported_sources,
           c.id AS own_id, c.status AS own_status, c.confidence AS own_confidence, c.source_msg_ids AS own_sources
    FROM facts l JOIN facts c ON c.chat_id = ${chatId} AND c.user_id = l.user_id AND c.kind = l.kind AND c.value_norm = l.value_norm
    WHERE l.chat_id = ${LEGACY_CHAT_ID}`;
  for (const pair of pairs) {
    const keepImported = !PERSONAL_STATUSES.has(pair.own_status) && PERSONAL_STATUSES.has(pair.imported_status);
    const [keep, drop] = keepImported ? [pair.imported_id, pair.own_id] : [pair.own_id, pair.imported_id];
    const sources = [...new Set(keepImported ? [...pair.own_sources, ...pair.imported_sources] : [...pair.imported_sources, ...pair.own_sources])].slice(-10);
    await tx`DELETE FROM facts WHERE id = ${drop}`;
    await tx`
      UPDATE facts SET chat_id = ${chatId}, source_msg_ids = ${sources},
             confidence = ${Math.max(pair.own_confidence, pair.imported_confidence)}, updated_at = now()
      WHERE id = ${keep}`;
  }
  await tx`UPDATE facts SET chat_id = ${chatId} WHERE chat_id = ${LEGACY_CHAT_ID}`;

  await tx`
    INSERT INTO rejected_facts (chat_id, user_id, kind, value_norm, created_at)
    SELECT ${chatId}, user_id, kind, value_norm, created_at FROM rejected_facts WHERE chat_id = ${LEGACY_CHAT_ID}
    ON CONFLICT DO NOTHING`;
  await tx`DELETE FROM rejected_facts WHERE chat_id = ${LEGACY_CHAT_ID}`;
  // A fact removed as wrong on either side must not come back through the other side's copy.
  const rejected = await tx<{ user_id: number; kind: string; value_norm: string }[]>`SELECT user_id, kind, value_norm FROM rejected_facts WHERE chat_id = ${chatId}`;
  if (rejected.length === 0) return;
  const candidates = await tx<{ id: number; user_id: number; kind: string; value: string }[]>`
    SELECT id, user_id, kind, value FROM facts
    WHERE chat_id = ${chatId} AND status IN ('auto', 'deprecated') AND user_id = ANY(${[...new Set(rejected.map((row) => row.user_id))]})`;
  const removed = candidates
    .filter((fact) => rejected.some((row) => row.user_id === fact.user_id && row.kind === fact.kind && isSameFact(fact.kind, row.value_norm, fact.value)))
    .map((fact) => fact.id);
  if (removed.length) await tx`DELETE FROM facts WHERE id = ANY(${removed})`;
}

/**
 * Someone who wrote in the chat before the import was attached got an account of their own, while
 * their imported card was not yet in the chat to be linked. Link the card now, by the same rules as
 * when a person writes: an unambiguous name, and a card no look-alike account could misuse (no
 * @username of its own, no other chat, no projects). Anything else is left to an owner's /link.
 */
async function linkImportedCards(sql: Sql, chatId: number, importedMembers: number[], actorUserId: number | undefined): Promise<number> {
  if (importedMembers.length === 0) return 0;
  const pairs = await sql<{ card_id: number; account_id: number }[]>`
    WITH people AS (
      SELECT u.id, u.tg_id, u.username, lower(u.display_name) AS name
      FROM users u JOIN members m ON m.user_id = u.id
      WHERE m.chat_id = ${chatId}
    ),
    cards AS (SELECT * FROM people WHERE tg_id IS NULL),
    accounts AS (SELECT * FROM people WHERE tg_id IS NOT NULL AND id <> ALL(${importedMembers}))
    SELECT c.id AS card_id, a.id AS account_id
    FROM cards c JOIN accounts a ON a.name = c.name
    WHERE c.id = ANY(${importedMembers}) AND c.username IS NULL
      AND (SELECT count(*) FROM cards x WHERE x.name = c.name) = 1
      AND (SELECT count(*) FROM accounts x WHERE x.name = c.name) = 1
      AND NOT EXISTS (SELECT 1 FROM members other WHERE other.user_id = c.id AND other.chat_id <> ${chatId})
      AND NOT EXISTS (SELECT 1 FROM project_members pm WHERE pm.user_id = c.id)
      -- Linking keeps the account's membership, so a card's opt-out would be lost: that one waits for an owner.
      AND NOT EXISTS (SELECT 1 FROM members own WHERE own.user_id = c.id AND own.chat_id = ${chatId} AND own.opted_out)`;
  let linked = 0;
  for (const pair of pairs) {
    try {
      await mergeSeedUser(sql, pair.card_id, pair.account_id, actorUserId ?? pair.account_id);
      linked += 1;
    } catch (error) {
      console.warn(`[chats] could not link imported card ${pair.card_id} to account ${pair.account_id}: ${String(error)}`);
    }
  }
  return linked;
}
