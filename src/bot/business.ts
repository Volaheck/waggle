import type { Api, Bot } from "grammy";
import type { BusinessConnection, Chat, Message } from "grammy/types";
import {
  addDays,
  localDate,
  reminderForOwner,
  saveDialogueLine,
  setReminderStatus,
  zonedTime,
  activeReminders,
} from "../core/business-reminders.js";
import {
  clearExpiredBusinessMessages,
  connectionById,
  connectionsOfOwner,
  saveConnection,
  takeDeletedMessages,
  upsertBusinessMessage,
  type BusinessConnectionRow,
  type BusinessMediaKind,
  type BusinessMessage,
} from "../core/business.js";
import type { Config } from "../core/config.js";
import type { Sql } from "../core/db.js";
import { portraitOf, savePortraitLine } from "../core/portrait.js";
import { escapeHtml, truncate } from "../core/text.js";
import { reminderButtons, reminderLine } from "../worker/business-reminders.js";
import { clampTelegram, countOf, formatDate } from "./format.js";
import type { BotContext } from "./kit.js";

/** One report stays well below Telegram's 4096 characters. */
const REPORT_MAX_CHARS = 3800;
const QUOTE_MAX_CHARS = 1000;
/** Clearing a whole chat must not flood the owner with every photo in it. */
const MEDIA_RESENT_PER_REPORT = 10;
const RETENTION_CHECK_MS = 60 * 60 * 1000;

const MEDIA_LABELS: Record<BusinessMediaKind, string> = {
  photo: "photo",
  video: "video",
  animation: "GIF",
  video_note: "video message",
  voice: "voice message",
  audio: "audio",
  document: "file",
  sticker: "sticker",
};

export const BUSINESS_UPDATES = ["business_connection", "business_message", "edited_business_message", "deleted_business_messages"] as const;

function mediaOf(message: Message): { kind: BusinessMediaKind; fileId: string } | null {
  const largestPhoto = message.photo?.at(-1);
  if (largestPhoto) return { kind: "photo", fileId: largestPhoto.file_id };
  // A GIF also carries `document`, so it has to be recognized first.
  if (message.animation) return { kind: "animation", fileId: message.animation.file_id };
  if (message.video) return { kind: "video", fileId: message.video.file_id };
  if (message.video_note) return { kind: "video_note", fileId: message.video_note.file_id };
  if (message.voice) return { kind: "voice", fileId: message.voice.file_id };
  if (message.audio) return { kind: "audio", fileId: message.audio.file_id };
  if (message.document) return { kind: "document", fileId: message.document.file_id };
  if (message.sticker) return { kind: "sticker", fileId: message.sticker.file_id };
  return null;
}

function textOf(message: Message): string {
  const text = message.text ?? message.caption;
  if (text) return text;
  if (message.poll) return `📊 ${message.poll.question}`;
  if (message.location) return "📍 location";
  if (message.contact) return "👤 contact";
  return "";
}

function nameOf(person: { first_name: string; last_name?: string; username?: string }): string {
  return [person.first_name, person.last_name].filter(Boolean).join(" ") || (person.username ? `@${person.username}` : "someone");
}

function chatName(chat: Chat.PrivateChat): string {
  return nameOf(chat);
}

/** What the bot keeps of a message from the other side of a connected chat; null when there is nothing to keep. */
export function toBusinessMessage(connectionId: string, message: Message): BusinessMessage | null {
  const media = mediaOf(message);
  const text = textOf(message);
  if (!media && !text) return null;
  return {
    connectionId,
    chatId: message.chat.id,
    msgId: message.message_id,
    fromTgId: message.from?.id ?? null,
    fromName: message.from ? nameOf(message.from) : chatName(message.chat as Chat.PrivateChat),
    text,
    mediaKind: media?.kind ?? null,
    fileId: media?.fileId ?? null,
    sentAt: new Date(message.date * 1000),
    editedAt: message.edit_date ? new Date(message.edit_date * 1000) : null,
  };
}

function quote(message: Pick<BusinessMessage, "text" | "mediaKind">): string {
  const media = message.mediaKind ? `[${MEDIA_LABELS[message.mediaKind]}]` : "";
  const text = message.text ? escapeHtml(truncate(message.text, QUOTE_MAX_CHARS)) : "";
  return `<blockquote>${[media, text].filter(Boolean).join(" ")}</blockquote>`;
}

export function deletedReport(chatWith: string, messages: BusinessMessage[], timeZone: string): string {
  const header = `🗑 Deleted in the chat with <b>${escapeHtml(chatWith)}</b>:`;
  const parts: string[] = [];
  let length = header.length;
  for (const [index, message] of messages.entries()) {
    const part = `<i>${escapeHtml(message.fromName)}, ${formatDate(message.sentAt, timeZone)}</i>\n${quote(message)}`;
    const rest = messages.length - index;
    if (length + part.length + 40 > REPORT_MAX_CHARS) {
      parts.push(`…and ${countOf(rest, "more message")}`);
      break;
    }
    parts.push(part);
    length += part.length + 1;
  }
  return [header, ...parts].join("\n");
}

export function editedReport(before: BusinessMessage, after: BusinessMessage, timeZone: string): string {
  return [
    `✏️ <b>${escapeHtml(after.fromName)}</b> edited a message from ${formatDate(before.sentAt, timeZone)}`,
    "Was:",
    quote(before),
    "Now:",
    quote(after),
  ].join("\n");
}

async function resendMedia(api: Api, chatId: number, kind: BusinessMediaKind, fileId: string, caption: string): Promise<void> {
  const withCaption = { caption, parse_mode: "HTML" as const };
  switch (kind) {
    case "photo":
      await api.sendPhoto(chatId, fileId, withCaption);
      return;
    case "video":
      await api.sendVideo(chatId, fileId, withCaption);
      return;
    case "animation":
      await api.sendAnimation(chatId, fileId, withCaption);
      return;
    case "voice":
      await api.sendVoice(chatId, fileId, withCaption);
      return;
    case "audio":
      await api.sendAudio(chatId, fileId, withCaption);
      return;
    case "document":
      await api.sendDocument(chatId, fileId, withCaption);
      return;
    case "video_note":
      await api.sendVideoNote(chatId, fileId);
      return;
    case "sticker":
      await api.sendSticker(chatId, fileId);
      return;
  }
}

/**
 * The bot connected to an owner's own account (Telegram Business → Chat Automation) keeps the other side's messages
 * in the chats it was given, and tells the owner in their DM with the bot when one of them is deleted or edited.
 * Only owners (ADMIN_TG_IDS) get this. Anyone who started a portrait (/portrait) has both sides of these chats read
 * for it; for anyone else the bot keeps nothing. The owner's own messages are not kept for deletion tracking.
 * Registered before every other handler: these updates never reach the group logic.
 */
export function registerBusiness(bot: Bot<BotContext>, deps: { sql: Sql; config: Config; remindersOn: boolean; portraitsOn: boolean }): void {
  const { sql, config, remindersOn, portraitsOn } = deps;
  const isOwner = (tgId: number) => config.ADMIN_TG_IDS.includes(tgId);
  const timeZone = config.DISPLAY_TIMEZONE;

  const store = (connection: BusinessConnection) =>
    saveConnection(sql, { id: connection.id, ownerTgId: connection.user.id, ownerChatId: connection.user_chat_id, enabled: connection.is_enabled });

  /**
   * The connection, when the bot keeps messages for it. A connection made before the bot listened to business
   * updates is looked up once.
   */
  const activeConnection = async (api: Api, id: string | undefined): Promise<BusinessConnectionRow | undefined> => {
    if (!id) return undefined;
    let connection = await connectionById(sql, id);
    if (!connection) {
      const fetched = await api.getBusinessConnection(id).catch((error: unknown) => {
        console.warn(`[business] could not look up connection ${id}: ${String(error)}`);
        return undefined;
      });
      if (!fetched) return undefined;
      await store(fetched);
      connection = await connectionById(sql, id);
    }
    return connection?.enabled ? connection : undefined;
  };

  const tell = (chatId: number, html: string) =>
    bot.api.sendMessage(chatId, html, { parse_mode: "HTML", link_preview_options: { is_disabled: true } }).catch((error: unknown) => {
      console.warn(`[business] could not report to ${chatId}: ${String(error)}`);
    });

  const resend = (chatId: number, kind: BusinessMediaKind, fileId: string, caption: string) =>
    resendMedia(bot.api, chatId, kind, fileId, caption).catch(async (error: unknown) => {
      console.warn(`[business] could not resend a ${kind}: ${String(error)}`);
      await tell(chatId, `${caption}\n(I couldn't send the ${MEDIA_LABELS[kind]} itself.)`);
    });

  bot.on("business_connection", async (ctx) => {
    const connection = ctx.businessConnection;
    const before = await connectionById(sql, connection.id);
    await store(connection);
    if (!isOwner(connection.user.id)) {
      const portrait = portraitsOn ? await portraitOf(sql, connection.user.id) : undefined;
      if (connection.is_enabled && !before?.enabled) {
        await tell(
          connection.user_chat_id,
          portrait?.status === "on"
            ? "🔌 <b>Connected.</b> Your private chats now go into your portrait too, both sides, read and then deleted. /portrait to see it, pause it or delete it."
            : portraitsOn
              ? "🔌 Deleted and edited messages are tracked only for this bot's owners. What I can do for you is a private portrait of your character from your chats: /portrait. Until you start one, I keep nothing from your chats."
              : "This bot tracks deleted and edited messages only for its owners. It keeps nothing from your chats.",
        );
      } else if (!connection.is_enabled && before?.enabled && portrait) {
        await tell(connection.user_chat_id, "🔌 <b>Disconnected.</b> Your portrait goes on from the groups only. /portrait to pause or delete it.");
      }
      return;
    }
    if (connection.is_enabled && !before?.enabled) {
      await tell(
        connection.user_chat_id,
        [
          "🔌 <b>Connected.</b> When someone deletes or edits a message in the chats you gave me, I'll show you here what it was.",
          `I keep their messages for ${countOf(config.BUSINESS_MESSAGE_RETENTION_DAYS, "day")}, your own messages not at all. Disconnecting deletes what I kept.`,
          ...(remindersOn
            ? [
                "",
                "⏰ I also read these chats, both sides, for promises and plans (“I'll send it tomorrow”, “call on Friday at 7”) and remind you of them here; /reminders lists them. The lines are kept for 2 days, and their text goes to Claude with phone numbers, emails and secrets masked.",
              ]
            : []),
          ...(portraitsOn ? ["", "🪞 /portrait: a private portrait of your character from these chats and the groups, if you want one."] : []),
        ].join("\n"),
      );
    } else if (!connection.is_enabled && before?.enabled) {
      await tell(connection.user_chat_id, "🔌 <b>Disconnected.</b> I've deleted the messages I kept from your chats.");
    }
  });

  /** Both sides go to the conversation the reminders are read from. */
  const keepDialogueLine = async (connection: BusinessConnectionRow, message: Message) => {
    if (!remindersOn) return;
    const media = mediaOf(message);
    const text = [media ? `[${MEDIA_LABELS[media.kind]}]` : "", textOf(message)].filter(Boolean).join(" ");
    if (!text) return;
    await saveDialogueLine(sql, {
      connectionId: connection.id,
      chatId: message.chat.id,
      msgId: message.message_id,
      fromOwner: message.from?.id === connection.owner_tg_id,
      chatName: chatName(message.chat as Chat.PrivateChat),
      text,
      sentAt: new Date(message.date * 1000),
    });
  };

  /** Both sides go to the person's portrait, when they started one. */
  const keepPortraitLine = async (connection: BusinessConnectionRow, message: Message) => {
    if (!portraitsOn) return;
    const media = mediaOf(message);
    const text = [media ? `[${MEDIA_LABELS[media.kind]}]` : "", textOf(message)].filter(Boolean).join(" ");
    if (!text) return;
    const fromSubject = message.from?.id === connection.owner_tg_id;
    await savePortraitLine(sql, connection.owner_tg_id, {
      chat_id: message.chat.id,
      msg_id: message.message_id,
      from_subject: fromSubject,
      speaker: fromSubject ? "me" : message.from ? nameOf(message.from) : chatName(message.chat as Chat.PrivateChat),
      text,
      sent_at: new Date(message.date * 1000),
    });
  };

  bot.on("business_message", async (ctx) => {
    const message = ctx.businessMessage;
    const connection = await activeConnection(ctx.api, message.business_connection_id);
    if (!connection) return;
    await keepPortraitLine(connection, message);
    if (!isOwner(connection.owner_tg_id)) return;
    await keepDialogueLine(connection, message);
    if (message.from?.id === connection.owner_tg_id) return;
    const kept = toBusinessMessage(connection.id, message);
    if (kept) await upsertBusinessMessage(sql, kept);
  });

  bot.on("edited_business_message", async (ctx) => {
    const message = ctx.editedBusinessMessage;
    const connection = await activeConnection(ctx.api, message.business_connection_id);
    if (!connection) return;
    await keepPortraitLine(connection, message);
    if (!isOwner(connection.owner_tg_id)) return;
    await keepDialogueLine(connection, message);
    if (message.from?.id === connection.owner_tg_id) return;
    const after = toBusinessMessage(connection.id, message);
    if (!after) return;
    const before = await upsertBusinessMessage(sql, after);
    // An edit of a message sent before the connection (or already expired) has nothing to compare with.
    if (!before || (before.text === after.text && before.fileId === after.fileId)) return;
    await tell(connection.owner_chat_id, editedReport(before, after, timeZone));
    if (before.mediaKind && before.fileId && before.fileId !== after.fileId) {
      await resend(connection.owner_chat_id, before.mediaKind, before.fileId, `✏️ ${escapeHtml(before.fromName)}: the ${MEDIA_LABELS[before.mediaKind]} before the edit`);
    }
  });

  bot.on("deleted_business_messages", async (ctx) => {
    const deleted = ctx.deletedBusinessMessages;
    const connection = await activeConnection(ctx.api, deleted.business_connection_id);
    if (!connection || !isOwner(connection.owner_tg_id)) return;
    const gone = await takeDeletedMessages(sql, connection.id, deleted.chat.id, deleted.message_ids);
    if (gone.length === 0) return;
    await tell(connection.owner_chat_id, deletedReport(chatName(deleted.chat), gone, timeZone));
    const media = gone.filter((message) => message.mediaKind && message.fileId);
    for (const message of media.slice(0, MEDIA_RESENT_PER_REPORT)) {
      await resend(connection.owner_chat_id, message.mediaKind!, message.fileId!, `🗑 ${escapeHtml(message.fromName)}, ${formatDate(message.sentAt, timeZone)}`);
    }
    if (media.length > MEDIA_RESENT_PER_REPORT) {
      await tell(connection.owner_chat_id, `…and ${countOf(media.length - MEDIA_RESENT_PER_REPORT, "more file")} I didn't resend.`);
    }
  });

  // ---------- Reminders: buttons and the list ----------

  bot.callbackQuery(/^bzr:(done|drop|hour|tomorrow):(\d+)$/, async (ctx) => {
    const [, action, rawId] = ctx.match;
    const reminder = isOwner(ctx.from.id) ? await reminderForOwner(sql, Number(rawId), ctx.from.id) : undefined;
    if (!reminder) return ctx.answerCallbackQuery({ text: "This reminder is gone" });
    const line = reminderLine(reminder, timeZone);
    let outcome: string;
    if (action === "done" || action === "drop") {
      await setReminderStatus(sql, reminder.id, action === "done" ? "done" : "dropped");
      outcome = action === "done" ? `✅ ${line}` : `✖ <s>${line}</s>`;
    } else {
      const at =
        action === "hour" ? new Date(Date.now() + 60 * 60 * 1000) : zonedTime(addDays(localDate(new Date(), timeZone), 1), "10:00", timeZone);
      await setReminderStatus(sql, reminder.id, "open", at);
      outcome = `⏰ ${line}\nAgain ${formatDate(at, timeZone)}.`;
    }
    await ctx.editMessageText(outcome, { parse_mode: "HTML" }).catch(() => {});
    await ctx.answerCallbackQuery();
  });

  bot.command("reminders", async (ctx, next) => {
    if (ctx.chat.type !== "private" || !ctx.from || !isOwner(ctx.from.id)) return next();
    if (!remindersOn) return ctx.reply("Reminders are off (no ANTHROPIC_API_KEY, or BUSINESS_REMINDERS_MONTHLY_BUDGET_USD is 0).");
    const connections = await connectionsOfOwner(sql, ctx.from.id);
    const reminders = (await Promise.all(connections.map((connection) => activeReminders(sql, connection.id)))).flat();
    if (connections.length === 0) {
      return ctx.reply("Connect me to your account first: Settings → Telegram Business → Chat Automation.");
    }
    if (reminders.length === 0) return ctx.reply("Nothing to remind you of yet.");
    const shown = reminders.slice(0, 10);
    for (const reminder of shown) {
      const when = reminder.status === "sent" ? "sent" : `reminder ${formatDate(reminder.remind_at, timeZone)}`;
      await ctx.reply(clampTelegram(`${reminderLine(reminder, timeZone)}\n<i>${when}</i>`), { parse_mode: "HTML", reply_markup: reminderButtons(reminder.id) });
    }
    if (reminders.length > shown.length) await ctx.reply(`…and ${countOf(reminders.length - shown.length, "more")}.`);
  });
}

/** Messages kept from connected chats are deleted after the retention period, reported or not. */
export function startBusinessRetention(sql: Sql, retentionDays: number, log: (line: string) => void = (line) => console.log(line)): () => void {
  const run = async () => {
    try {
      const cleared = await clearExpiredBusinessMessages(sql, retentionDays);
      if (cleared) log(`[business] deleted ${cleared} kept message(s) older than ${retentionDays} days`);
    } catch (error) {
      log(`[business] retention failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  void run();
  const timer = setInterval(() => void run(), RETENTION_CHECK_MS);
  return () => clearInterval(timer);
}

/** Reading owners' DMs for promises and plans needs the model and a cap above zero. */
export function businessRemindersOn(anthropic: unknown, config: Pick<Config, "BUSINESS_REMINDERS_MONTHLY_BUDGET_USD">): boolean {
  return Boolean(anthropic) && config.BUSINESS_REMINDERS_MONTHLY_BUDGET_USD > 0;
}
