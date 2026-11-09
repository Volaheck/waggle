import type { Sql } from "./db.js";

export type BusinessMediaKind = "photo" | "video" | "animation" | "video_note" | "voice" | "audio" | "document" | "sticker";

export interface BusinessConnectionRow {
  id: string;
  owner_tg_id: number;
  owner_chat_id: number;
  enabled: boolean;
}

export interface BusinessMessage {
  connectionId: string;
  chatId: number;
  msgId: number;
  fromTgId: number | null;
  fromName: string;
  text: string;
  mediaKind: BusinessMediaKind | null;
  fileId: string | null;
  sentAt: Date;
  editedAt: Date | null;
}

interface BusinessMessageRow {
  connection_id: string;
  chat_id: number;
  msg_id: number;
  from_tg_id: number | null;
  from_name: string;
  text: string;
  media_kind: BusinessMediaKind | null;
  file_id: string | null;
  sent_at: Date;
  edited_at: Date | null;
}

const fromRow = (row: BusinessMessageRow): BusinessMessage => ({
  connectionId: row.connection_id,
  chatId: row.chat_id,
  msgId: row.msg_id,
  fromTgId: row.from_tg_id,
  fromName: row.from_name,
  text: row.text,
  mediaKind: row.media_kind,
  fileId: row.file_id,
  sentAt: row.sent_at,
  editedAt: row.edited_at,
});

export async function saveConnection(sql: Sql, connection: { id: string; ownerTgId: number; ownerChatId: number; enabled: boolean }): Promise<void> {
  await sql`
    INSERT INTO business_connections (id, owner_tg_id, owner_chat_id, enabled)
    VALUES (${connection.id}, ${connection.ownerTgId}, ${connection.ownerChatId}, ${connection.enabled})
    ON CONFLICT (id) DO UPDATE SET owner_tg_id = excluded.owner_tg_id, owner_chat_id = excluded.owner_chat_id, enabled = excluded.enabled, updated_at = now()`;
  if (!connection.enabled) {
    await sql`DELETE FROM business_messages WHERE connection_id = ${connection.id}`;
    await sql`DELETE FROM business_dialogue WHERE connection_id = ${connection.id}`;
    await sql`DELETE FROM business_reminders WHERE connection_id = ${connection.id}`;
  }
}

export async function connectionById(sql: Sql, id: string): Promise<BusinessConnectionRow | undefined> {
  const [row] = await sql<BusinessConnectionRow[]>`SELECT id, owner_tg_id, owner_chat_id, enabled FROM business_connections WHERE id = ${id}`;
  return row;
}

/** Stores the message, or its new version after an edit; returns the version stored before, if there was one. */
export async function upsertBusinessMessage(sql: Sql, message: BusinessMessage): Promise<BusinessMessage | undefined> {
  return sql.begin(async (tx) => {
    const [before] = await tx<BusinessMessageRow[]>`
      SELECT * FROM business_messages
      WHERE connection_id = ${message.connectionId} AND chat_id = ${message.chatId} AND msg_id = ${message.msgId}
      FOR UPDATE`;
    await tx`
      INSERT INTO business_messages (connection_id, chat_id, msg_id, from_tg_id, from_name, text, media_kind, file_id, sent_at, edited_at)
      VALUES (${message.connectionId}, ${message.chatId}, ${message.msgId}, ${message.fromTgId}, ${message.fromName}, ${message.text},
              ${message.mediaKind}, ${message.fileId}, ${message.sentAt}, ${message.editedAt})
      ON CONFLICT (connection_id, chat_id, msg_id) DO UPDATE SET
        from_name = excluded.from_name, text = excluded.text, media_kind = excluded.media_kind, file_id = excluded.file_id, edited_at = excluded.edited_at`;
    return before ? fromRow(before) : undefined;
  });
}

/** Removes the deleted messages and returns the ones that were kept, oldest first. */
export async function takeDeletedMessages(sql: Sql, connectionId: string, chatId: number, msgIds: number[]): Promise<BusinessMessage[]> {
  if (msgIds.length === 0) return [];
  const rows = await sql<BusinessMessageRow[]>`
    DELETE FROM business_messages
    WHERE connection_id = ${connectionId} AND chat_id = ${chatId} AND msg_id = ANY(${msgIds}::bigint[])
    RETURNING *`;
  return rows.map(fromRow).sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime() || a.msgId - b.msgId);
}

export async function clearExpiredBusinessMessages(sql: Sql, retentionDays: number): Promise<number> {
  const rows = await sql`DELETE FROM business_messages WHERE sent_at < now() - make_interval(days => ${retentionDays}) RETURNING 1`;
  return rows.length;
}

export async function connectionsOfOwner(sql: Sql, ownerTgId: number): Promise<BusinessConnectionRow[]> {
  return sql<BusinessConnectionRow[]>`
    SELECT id, owner_tg_id, owner_chat_id, enabled FROM business_connections WHERE owner_tg_id = ${ownerTgId} AND enabled ORDER BY updated_at`;
}
