import { GrammyError, type Api } from "grammy";
import type { Message, MessageEntity, Update, User as TelegramUser, UserFromGetMe } from "grammy/types";
import { getChat, type Chat } from "../core/chats.js";
import type { Sql } from "../core/db.js";
import { executionStarted, recordExecution, type MemberReminder } from "../core/member-reminders.js";
import { getUser, markLeft } from "../core/users.js";
import type { Assistant } from "./assistant.js";
import { isInChat } from "./membership.js";
import type { Question } from "./reply-context.js";
import type { SelfEdits } from "./self-edits.js";

/**
 * Does what a member asked the bot to do for them later («через 2 часа поставь мне статус «в отпуске»», «завтра в 9
 * расскажи, что обсуждали ночью», «в понедельник в 9 /top») once it is due (src/worker/member-reminders.ts), as if they
 * had just asked: the words of the action become a message of theirs again, under the id of the message that asked for
 * it, so every reply threads under that request and every stored answer replies to a real message of theirs. A command
 * goes through the bot's own handlers, with their own checks and output; anything else goes where a message addressed
 * to the bot goes, the card requests first (src/bot/self-edits.ts), told that it was asked earlier for now.
 *
 * It is done only while the chat is approved and its asker is still in it, by Telegram's word, may write there and keeps
 * their card there; otherwise it is dropped without a word. What it posts goes to the forum topic it was asked in, and
 * outside it once that topic is closed or deleted. And it is done once: its record goes on file as it starts, under an
 * id no message has (executionMsgId), so a second try, after a crash say, finds it there and does nothing.
 */

/** What became of an action at its time, as the worker finishes it. */
export type Performed = "sent" | "pending" | "cancelled" | "failed";

/**
 * The request an action is done for, at its time: no handler may delete or edit that message, and what the action posts
 * goes to its forum topic while the topic takes it.
 */
export interface Replay {
  chatId: number;
  msgId: number;
  /** The forum topic the request was asked in; null outside topics. */
  threadId: number | null;
}

export interface PerformerDeps {
  sql: Sql;
  /** The bot's own API, for asking Telegram about the asker. */
  api: Api;
  /**
   * The bot's API for what an action does: the request stays out of its reach, and what it posts goes outside the
   * request's topic once that topic is closed or deleted.
   */
  apiFor: (replay: Replay) => Api;
  /** The bot itself, as Telegram knows it. */
  me: () => UserFromGetMe;
  /** Every name the bot's commands answer to: an action that starts with one is that command. */
  commands: ReadonlySet<string>;
  /** Runs an update through the bot's own handlers, their calls made as through `apiFor(replay)`. */
  dispatch: (update: Update, replay: Replay) => Promise<void>;
  selfEdits?: Pick<SelfEdits, "handle">;
  assistant?: Pick<Assistant, "answer">;
  log?: (line: string) => void;
  now?: () => Date;
}

/** Telegram's word that a forum topic takes no message: closed or deleted since («TOPIC_CLOSED», «message thread not found»). */
export const topicGone = (errorCode: number, description: string) => errorCode === 400 && /thread|topic/i.test(description);

/** How the record of an action done outside the card requests is kept: a command, or an answer where they do not run. */
const EXECUTION_KINDS = { command: "command", answer: "not_a_request" } as const;

/** The length of the bot command an action starts with, when it is one of the bot's own; null otherwise. */
export function commandLength(text: string, me: Pick<UserFromGetMe, "username">, commands: ReadonlySet<string>): number | null {
  const match = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{3,32}))?(?![A-Za-z0-9_@])/.exec(text);
  if (!match || !commands.has(match[1]!)) return null;
  if (match[2] !== undefined && match[2].toLowerCase() !== me.username.toLowerCase()) return null;
  return match[0].length;
}

/**
 * Whether the asker is in the chat now, by Telegram's word, with their account as it is now: "muted" when the chat's
 * admins took away their right to write there, and "unknown" when Telegram can't be asked.
 */
async function memberNow(api: Api, chatId: number, tgId: number): Promise<TelegramUser | "left" | "muted" | "unknown"> {
  try {
    const member = await api.getChatMember(chatId, tgId);
    if (!isInChat(member)) return "left";
    return member.status === "restricted" && !member.can_send_messages ? "muted" : member.user;
  } catch (error) {
    // Telegram answers this way for an account that is not in the chat; anything else says nothing about the person (a
    // bot removed from the chat is told apart by the chat's own status, on the next try).
    if (error instanceof GrammyError && error.error_code === 400 && /user not found|participant_id_invalid|member not found/i.test(error.description)) return "left";
    return "unknown";
  }
}

const botAsSender = (me: UserFromGetMe): TelegramUser => ({ id: me.id, is_bot: true, first_name: me.first_name, username: me.username });

/**
 * The message the request replied to, rebuilt: its text as the action kept it when it was the requester's own or the
 * bot's to them, anyone else's as the chat still keeps it; none once that is gone, or once its author has edited it
 * since the request, whose asker never saw those words.
 */
async function repliedMessage(sql: Sql, reminder: MemberReminder, chat: Chat, from: TelegramUser, me: UserFromGetMe): Promise<Message["reply_to_message"]> {
  if (reminder.reply_to_msg_id === null) return undefined;
  const [stored] = await sql<
    { text: string; sent_at: Date; edited_at: Date | null; from_bot: boolean; is_forward: boolean; forward_source: string | null; tg_id: number | null; display_name: string | null; username: string | null }[]
  >`
    SELECT m.text, m.sent_at, m.edited_at, m.from_bot, m.is_forward, m.forward_source, u.tg_id, u.display_name, u.username
    FROM messages m LEFT JOIN users u ON u.id = m.user_id
    WHERE m.chat_id = ${reminder.chat_id} AND m.msg_id = ${reminder.reply_to_msg_id}`;
  const base = { message_id: reminder.reply_to_msg_id, date: Math.floor((stored?.sent_at ?? reminder.created_at).getTime() / 1000), chat: { id: chat.id, type: "supergroup" as const, title: chat.title ?? "" } };
  if (reminder.reply_text !== null) return { ...base, from: reminder.reply_author === "bot" ? botAsSender(me) : from, text: reminder.reply_text } as Message["reply_to_message"];
  if (!stored || !stored.text.trim() || (stored.edited_at !== null && stored.edited_at > reminder.created_at)) return undefined;
  const author = stored.from_bot ? botAsSender(me) : stored.tg_id !== null ? { id: stored.tg_id, is_bot: false, first_name: stored.display_name ?? "", ...(stored.username ? { username: stored.username } : {}) } : undefined;
  const forwarded = stored.is_forward ? { forward_origin: { type: "hidden_user" as const, sender_user_name: stored.forward_source ?? "", date: base.date } } : {};
  return { ...base, ...(author ? { from: author } : {}), ...forwarded, text: stored.text } as Message["reply_to_message"];
}

export function createPerformer(deps: PerformerDeps): (reminder: MemberReminder) => Promise<Performed> {
  const { sql, api } = deps;
  const log = deps.log ?? ((line: string) => console.log(line));

  return async (reminder) => {
    // Started once already (the bot stopped while it was under way): never done twice.
    if (await executionStarted(sql, reminder)) return "sent";
    const chat = await getChat(sql, reminder.chat_id);
    const user = await getUser(sql, reminder.user_id);
    const [member] = await sql<{ opted_out: boolean }[]>`SELECT opted_out FROM members WHERE chat_id = ${reminder.chat_id} AND user_id = ${reminder.user_id}`;
    if (chat?.status !== "approved" || !user?.tg_id || member?.opted_out !== false) return "cancelled";
    const from = await memberNow(api, chat.id, user.tg_id);
    if (from === "unknown") return "pending";
    if (from === "left") {
      await markLeft(sql, chat.id, user.tg_id);
      log(`[later] action ${reminder.id}: its asker has left chat ${chat.id}; it is dropped`);
      return "cancelled";
    }
    // Someone who may not write in the chat now could not ask for it now: the bot does not speak for them either.
    if (from === "muted") {
      log(`[later] action ${reminder.id}: its asker may not write in chat ${chat.id} now; it is dropped`);
      return "cancelled";
    }
    const me = deps.me();
    const replay: Replay = { chatId: chat.id, msgId: reminder.source_msg_id, threadId: reminder.thread_id !== null && reminder.thread_id > 0 ? reminder.thread_id : null };
    const [asked] = await sql<{ sent_at: Date }[]>`SELECT sent_at FROM messages WHERE chat_id = ${reminder.chat_id} AND msg_id = ${reminder.source_msg_id}`;
    const replied = await repliedMessage(sql, reminder, chat, from, me);
    const command = commandLength(reminder.text, me, deps.commands);
    const entities: MessageEntity[] = command === null ? [] : [{ type: "bot_command", offset: 0, length: command }];
    const message = {
      message_id: reminder.source_msg_id,
      date: Math.floor((deps.now?.() ?? new Date()).getTime() / 1000),
      chat: { id: chat.id, type: "supergroup", title: chat.title ?? "" },
      from,
      text: reminder.text,
      ...(entities.length ? { entities } : {}),
      ...(replay.threadId !== null ? { is_topic_message: true, message_thread_id: replay.threadId } : {}),
      ...(replied ? { reply_to_message: replied } : {}),
    } as Message;

    if (command !== null) {
      // A command is never stored as a message, so its record alone says it ran.
      if (!(await recordExecution(sql, reminder, user.tg_id, EXECUTION_KINDS.command))) return "sent";
      log(`[later] action ${reminder.id}: running ${reminder.text.slice(0, command)} for user ${user.id} in chat ${chat.id}`);
      await deps.dispatch({ update_id: 0, message } as Update, replay);
      return "sent";
    }
    const question: Question = { chatId: chat.id, chatTitle: chat.title, message, from, me, scheduled: { reminderId: reminder.id, askedAt: asked?.sent_at ?? reminder.created_at } };
    if (deps.selfEdits) {
      const recorded = await deps.selfEdits.handle(deps.apiFor(replay), question, user);
      if (recorded !== undefined) log(`[later] action ${reminder.id}: doing it for user ${user.id} in chat ${chat.id}`);
      return "sent";
    }
    if (deps.assistant) {
      if (await recordExecution(sql, reminder, user.tg_id, EXECUTION_KINDS.answer)) deps.assistant.answer(deps.apiFor(replay), question);
      return "sent";
    }
    log(`[later] action ${reminder.id}: answers are off, so nothing but a command can be done; it is dropped`);
    return "failed";
  };
}
