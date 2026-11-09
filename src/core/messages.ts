import type { Queryable, Sql } from "./db.js";

export interface IncomingMessage {
  chatId: number;
  msgId: number;
  userId: number | null;
  sentAt: Date;
  text: string;
  replyToMsgId: number | null;
  /** The message answers one the bot itself posted (a card, the top, the chronicle); the bot never sees its own messages. */
  replyToBot?: boolean;
  isForward: boolean;
  forwardSource: string | null;
  mediaType: string | null;
}

export interface StoredMessage {
  chat_id: number;
  msg_id: number;
  user_id: number | null;
  sent_at: Date;
  text: string;
  reply_to_msg_id: number | null;
  reply_to_bot?: boolean;
  is_forward: boolean;
  forward_source: string | null;
  media_type: string | null;
  /** Posted by the bot itself (user_id is NULL). */
  from_bot?: boolean;
}

/** Returns false when the message was stored already (Telegram delivered the update again). */
export async function saveMessage(sql: Sql, message: IncomingMessage): Promise<boolean> {
  const inserted = await sql`
    INSERT INTO messages (chat_id, msg_id, user_id, sent_at, text, reply_to_msg_id, reply_to_bot, is_forward, forward_source, media_type)
    VALUES (${message.chatId}, ${message.msgId}, ${message.userId}, ${message.sentAt}, ${message.text},
            ${message.replyToMsgId}, ${message.replyToBot ?? false}, ${message.isForward}, ${message.forwardSource}, ${message.mediaType})
    ON CONFLICT (chat_id, msg_id) DO NOTHING`;
  if (message.userId !== null) {
    await sql`
      INSERT INTO members (chat_id, user_id, first_seen_at, last_message_at)
      VALUES (${message.chatId}, ${message.userId}, ${message.sentAt}, ${message.sentAt})
      ON CONFLICT (chat_id, user_id) DO UPDATE
      SET last_message_at = greatest(coalesce(members.last_message_at, excluded.last_message_at), excluded.last_message_at),
          first_seen_at = least(coalesce(members.first_seen_at, excluded.first_seen_at), excluded.first_seen_at),
          left_at = NULL`;
  }
  return inserted.count > 0;
}

export interface OutgoingMessage {
  chatId: number;
  msgId: number;
  sentAt: Date;
  text: string;
  replyToMsgId: number | null;
}

/**
 * Telegram never sends the bot its own messages, so what it posts in an approved group is stored here, without an
 * author. The chronicler goes through these rows like any others (as context it never takes facts from), and the
 * usual retention clears their texts.
 */
export async function saveBotMessage(sql: Queryable, message: OutgoingMessage): Promise<boolean> {
  const inserted = await sql`
    INSERT INTO messages (chat_id, msg_id, user_id, sent_at, text, reply_to_msg_id, from_bot)
    SELECT ${message.chatId}, ${message.msgId}, NULL, ${message.sentAt}, ${message.text}, ${message.replyToMsgId}, true
    WHERE EXISTS (SELECT 1 FROM chats WHERE id = ${message.chatId} AND status = 'approved')
    ON CONFLICT (chat_id, msg_id) DO NOTHING`;
  return inserted.count > 0;
}

export async function updateBotMessage(sql: Queryable, chatId: number, msgId: number, text: string, editedAt: Date): Promise<void> {
  await sql`UPDATE messages SET text = ${text}, edited_at = ${editedAt} WHERE chat_id = ${chatId} AND msg_id = ${msgId} AND from_bot`;
}

export async function updateEditedMessage(sql: Sql, chatId: number, msgId: number, text: string, editedAt: Date): Promise<void> {
  await sql`
    UPDATE messages SET text = ${text}, edited_at = ${editedAt}, extracted_at = NULL
    WHERE chat_id = ${chatId} AND msg_id = ${msgId}`;
}

/**
 * Message texts are kept no longer than they are needed: a message older than `retentionDays` that the chronicler
 * has processed loses its text and the name of the source it was forwarded from. The row stays (author, time, ids),
 * so links to the message and activity counts keep working. A message still waiting for the chronicler (a paused
 * chronicler, a used-up budget) keeps its text until it is processed. Returns how many messages were cleared.
 */
export async function clearExpiredTexts(sql: Queryable, retentionDays: number): Promise<number> {
  const cleared = await sql`
    UPDATE messages SET text = '', forward_source = NULL
    WHERE extracted_at IS NOT NULL AND sent_at < now() - ${`${retentionDays} days`}::interval
      AND (text <> '' OR forward_source IS NOT NULL)`;
  return cleared.count;
}

export async function messagesAround(sql: Sql, chatId: number, msgIds: number[], radius: number): Promise<StoredMessage[]> {
  if (msgIds.length === 0) return [];
  return sql<StoredMessage[]>`
    SELECT DISTINCT m.chat_id, m.msg_id, m.user_id, m.sent_at, m.text, m.reply_to_msg_id, m.is_forward, m.forward_source, m.media_type
    FROM messages m
    JOIN unnest(${msgIds}::bigint[]) AS hit(id) ON m.msg_id BETWEEN hit.id - ${radius} AND hit.id + ${radius}
    WHERE m.chat_id = ${chatId}
    ORDER BY m.msg_id`;
}
