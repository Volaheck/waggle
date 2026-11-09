import type { Sql } from "./db.js";

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

/**
 * Moves imported history (chat_id = 0) into a real chat. Rows that would collide with
 * what the chat already has (same message id, same fact, same slug) keep the chat's version.
 */
export async function attachLegacyData(sql: Sql, chatId: number): Promise<LegacyStats> {
  const before = await legacyStats(sql);
  await sql.begin(async (tx) => {
    const legacy = LEGACY_CHAT_ID;
    await tx`
      INSERT INTO members (chat_id, user_id, tagline, tagline_manual, opted_out, first_seen_at, last_message_at, left_at)
      SELECT ${chatId}, user_id, tagline, tagline_manual, opted_out, first_seen_at, last_message_at, left_at FROM members WHERE chat_id = ${legacy}
      ON CONFLICT (chat_id, user_id) DO UPDATE SET
        tagline = coalesce(members.tagline, excluded.tagline),
        tagline_manual = members.tagline_manual OR excluded.tagline_manual,
        opted_out = members.opted_out OR excluded.opted_out,
        first_seen_at = least(members.first_seen_at, excluded.first_seen_at),
        last_message_at = greatest(members.last_message_at, excluded.last_message_at)`;
    await tx`DELETE FROM members WHERE chat_id = ${legacy}`;
    await tx`
      UPDATE messages m SET chat_id = ${chatId}
      WHERE m.chat_id = ${legacy} AND NOT EXISTS (SELECT 1 FROM messages x WHERE x.chat_id = ${chatId} AND x.msg_id = m.msg_id)`;
    await tx`
      UPDATE facts f SET chat_id = ${chatId}
      WHERE f.chat_id = ${legacy}
        AND NOT EXISTS (SELECT 1 FROM facts x WHERE x.chat_id = ${chatId} AND x.user_id = f.user_id AND x.kind = f.kind AND x.value_norm = f.value_norm)`;
    await tx`
      UPDATE rejected_facts r SET chat_id = ${chatId}
      WHERE r.chat_id = ${legacy}
        AND NOT EXISTS (SELECT 1 FROM rejected_facts x WHERE x.chat_id = ${chatId} AND x.user_id = r.user_id AND x.kind = r.kind AND x.value_norm = r.value_norm)`;
    await tx`
      UPDATE projects p SET chat_id = ${chatId}
      WHERE p.chat_id = ${legacy} AND NOT EXISTS (SELECT 1 FROM projects x WHERE x.chat_id = ${chatId} AND x.slug = p.slug)`;
    await tx`
      UPDATE links l SET chat_id = ${chatId}
      WHERE l.chat_id = ${legacy} AND NOT EXISTS (SELECT 1 FROM links x WHERE x.chat_id = ${chatId} AND x.url_norm = l.url_norm)`;
    await tx`UPDATE chronicle SET chat_id = ${chatId} WHERE chat_id = ${legacy}`;
    await tx`UPDATE extraction_runs SET chat_id = ${chatId} WHERE chat_id = ${legacy}`;
    await tx`UPDATE llm_usage SET chat_id = ${chatId} WHERE chat_id = ${legacy} OR chat_id IS NULL`;
    for (const table of ["messages", "facts", "rejected_facts", "projects", "links"] as const) {
      await tx`DELETE FROM ${tx(table)} WHERE chat_id = ${legacy}`;
    }
  });
  return before;
}
