import type { Transformer } from "grammy";
import type { Message } from "grammy/types";
import type { Sql } from "../core/db.js";
import { saveBotMessage, updateBotMessage } from "../core/messages.js";

interface SentPayload {
  reply_parameters?: { message_id?: number; chat_id?: number | string };
}

/**
 * Keeps what the bot posts in approved groups (see saveBotMessage), so an answer can follow a conversation with the
 * bot back to its start. grammY runs the transformer installed last first: this one has to be installed after the
 * transport it wraps, or it never sees a result. Storing never gets in the way of sending.
 */
export function outgoingLog(sql: Sql, warn: (line: string) => void = console.warn): Transformer {
  return async (prev, method, payload, signal) => {
    const response = await prev(method, payload, signal);
    if (!response.ok || (method !== "sendMessage" && method !== "editMessageText")) return response;
    try {
      const sent = response.result as Message | true;
      if (sent === true || (sent.chat?.type !== "group" && sent.chat?.type !== "supergroup")) return response;
      const text = sent.text ?? sent.caption ?? "";
      if (method === "editMessageText") {
        await updateBotMessage(sql, sent.chat.id, sent.message_id, text, sent.edit_date ? new Date(sent.edit_date * 1000) : new Date());
      } else {
        const reply = (payload as SentPayload).reply_parameters;
        await saveBotMessage(sql, {
          chatId: sent.chat.id,
          msgId: sent.message_id,
          sentAt: sent.date ? new Date(sent.date * 1000) : new Date(),
          text,
          replyToMsgId: reply?.message_id !== undefined && reply.chat_id === undefined ? reply.message_id : null,
          threadId: sent.is_topic_message ? (sent.message_thread_id ?? null) : null,
        });
      }
    } catch (error) {
      warn(`[bot] could not store a message the bot sent (${method}): ${String(error)}`);
    }
    return response;
  };
}
