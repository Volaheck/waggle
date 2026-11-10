import type { Queryable, Sql } from "./db.js";

/**
 * Notes members write themselves (migrations/009_memos.sql): about themselves, or about a project they are an author
 * of, by asking the bot in the chat (src/bot/self-edits.ts) or in the Mini App. They are their own words, so they are
 * shown as written and outrank what the chronicler inferred; nobody writes a note for someone else.
 */

export interface Memo {
  id: number;
  user_id: number;
  project_id: number | null;
  text: string;
  created_at: Date;
}

export interface ProjectMemo extends Memo {
  display_name: string;
}

export const MAX_MEMO_CHARS = 300;
/** Notes a member keeps about themselves, and notes a project keeps from each of its authors. */
export const MAX_MEMOS = 20;

/** The members' notes about themselves, newest first. */
export async function memosOf(sql: Queryable, chatId: number, userIds: number[]): Promise<Memo[]> {
  if (userIds.length === 0) return [];
  return sql<Memo[]>`
    SELECT id, user_id, project_id, text, created_at FROM memos
    WHERE chat_id = ${chatId} AND user_id = ANY(${userIds}::int[]) AND project_id IS NULL
    ORDER BY created_at DESC, id DESC`;
}

/** The notes of the projects, by authors who still are, newest first. */
export async function projectMemos(sql: Queryable, projectIds: number[]): Promise<ProjectMemo[]> {
  if (projectIds.length === 0) return [];
  return sql<ProjectMemo[]>`
    SELECT n.id, n.user_id, n.project_id, n.text, n.created_at, u.display_name
    FROM memos n JOIN users u ON u.id = n.user_id
    WHERE n.project_id = ANY(${projectIds}::int[]) AND EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = n.project_id AND pm.user_id = n.user_id)
    ORDER BY n.created_at DESC, n.id DESC`;
}

/** Every note the member wrote in the chat, with the name of the project it is about. */
export async function ownMemos(sql: Queryable, chatId: number, userId: number): Promise<(Memo & { project_name: string | null })[]> {
  return sql<(Memo & { project_name: string | null })[]>`
    SELECT n.id, n.user_id, n.project_id, n.text, n.created_at, p.name AS project_name
    FROM memos n LEFT JOIN projects p ON p.id = n.project_id
    WHERE n.chat_id = ${chatId} AND n.user_id = ${userId} AND (n.project_id IS NULL OR NOT p.hidden)
    ORDER BY n.project_id NULLS FIRST, n.created_at DESC, n.id DESC`;
}

/** Whether the member may write a note on the project: one of its authors, the project of this chat and visible. */
export async function canNoteProject(sql: Queryable, chatId: number, projectId: number, userId: number): Promise<boolean> {
  const [row] = await sql`
    SELECT 1 FROM projects p JOIN project_members pm ON pm.project_id = p.id
    WHERE p.id = ${projectId} AND p.chat_id = ${chatId} AND NOT p.hidden AND pm.user_id = ${userId}`;
  return Boolean(row);
}

/** A note written in the Mini App; the caller has checked who may write it and what it says. Null past the limit. */
export async function addMemo(sql: Sql, input: { chatId: number; userId: number; projectId: number | null; text: string }): Promise<Memo | null> {
  return sql.begin(async (tx) => {
    const [kept] = await tx<{ count: number }[]>`
      SELECT count(*)::int AS count FROM memos WHERE chat_id = ${input.chatId} AND user_id = ${input.userId} AND project_id IS NOT DISTINCT FROM ${input.projectId}`;
    if ((kept?.count ?? 0) >= MAX_MEMOS) return null;
    const [memo] = await tx<Memo[]>`
      INSERT INTO memos (chat_id, user_id, project_id, text) VALUES (${input.chatId}, ${input.userId}, ${input.projectId}, ${input.text})
      RETURNING id, user_id, project_id, text, created_at`;
    await tx`
      INSERT INTO change_log (entity, entity_id, op, after, source, actor_user_id)
      VALUES ('memo', ${memo!.id}, 'add', ${tx.json({ text: input.text, project_id: input.projectId, chat_id: input.chatId })}, 'user', ${input.userId})`;
    return memo!;
  }) as Promise<Memo | null>;
}

/** Deletes a note of the chat: its author's own, or any for a bot owner. */
export async function deleteMemo(sql: Sql, input: { chatId: number; memoId: number; actorUserId: number; asOwner: boolean }): Promise<boolean> {
  return sql.begin(async (tx) => {
    const [memo] = await tx<Memo[]>`
      DELETE FROM memos WHERE id = ${input.memoId} AND chat_id = ${input.chatId} AND (user_id = ${input.actorUserId} OR ${input.asOwner})
      RETURNING id, user_id, project_id, text, created_at`;
    if (!memo) return false;
    await tx`
      INSERT INTO change_log (entity, entity_id, op, before, source, actor_user_id)
      VALUES ('memo', ${memo.id}, 'remove', ${tx.json({ text: memo.text, project_id: memo.project_id, user_id: memo.user_id })}, ${memo.user_id === input.actorUserId ? "user" : "admin"}, ${input.actorUserId})`;
    return true;
  }) as Promise<boolean>;
}
