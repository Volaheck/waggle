import type { Sql } from "./db.js";
import { extractUrls, normalizeUrl, truncate } from "./text.js";

export interface IncomingMessage {
  chatId: number;
  msgId: number;
  userId: number | null;
  sentAt: Date;
  text: string;
  replyToMsgId: number | null;
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
  is_forward: boolean;
  forward_source: string | null;
  media_type: string | null;
}

export async function saveMessage(sql: Sql, message: IncomingMessage): Promise<void> {
  await sql`
    INSERT INTO messages (chat_id, msg_id, user_id, sent_at, text, reply_to_msg_id, is_forward, forward_source, media_type)
    VALUES (${message.chatId}, ${message.msgId}, ${message.userId}, ${message.sentAt}, ${message.text},
            ${message.replyToMsgId}, ${message.isForward}, ${message.forwardSource}, ${message.mediaType})
    ON CONFLICT (chat_id, msg_id) DO NOTHING`;
  if (message.userId !== null) {
    await sql`
      UPDATE users
      SET last_message_at = greatest(coalesce(last_message_at, ${message.sentAt}), ${message.sentAt}),
          first_seen_at = least(coalesce(first_seen_at, ${message.sentAt}), ${message.sentAt})
      WHERE id = ${message.userId}`;
  }
  await recordLinks(sql, message);
}

export async function updateEditedMessage(sql: Sql, chatId: number, msgId: number, text: string, editedAt: Date): Promise<void> {
  await sql`
    UPDATE messages SET text = ${text}, edited_at = ${editedAt}, extracted_at = NULL
    WHERE chat_id = ${chatId} AND msg_id = ${msgId}`;
}

async function recordLinks(sql: Sql, message: IncomingMessage): Promise<void> {
  for (const url of extractUrls(message.text)) {
    const normalized = normalizeUrl(url);
    if (!normalized || normalized.domain === "t.me") continue;
    const context = truncate(message.text.replace(url, " ").replace(/\s+/g, " ").trim(), 280) || null;
    await sql`
      INSERT INTO links (url_norm, url, domain, first_user_id, first_msg_id, last_msg_id, from_forward, context, first_seen_at)
      VALUES (${normalized.norm}, ${url}, ${normalized.domain}, ${message.userId}, ${message.msgId}, ${message.msgId},
              ${message.isForward}, ${context}, ${message.sentAt})
      ON CONFLICT (url_norm) DO UPDATE
      SET share_count = links.share_count + 1,
          last_msg_id = greatest(links.last_msg_id, excluded.last_msg_id),
          context = coalesce(links.context, excluded.context)`;
  }
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
