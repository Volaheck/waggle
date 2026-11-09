import { InlineKeyboard, type Bot, type Context } from "grammy";
import type { InlineKeyboardButton, Message, User as TelegramUser } from "grammy/types";
import { approvedChats, chatsOfUser, isApproved, setCurrentChat, type Chat } from "../core/chats.js";
import type { Config } from "../core/config.js";
import type { Sql } from "../core/db.js";
import { ensureMember, getPerson, markLeft, resolveUser, type Person, type User } from "../core/users.js";
import { clampTelegram } from "./format.js";
import type { MembershipCache } from "./membership.js";

export type BotContext = Context;

export type PendingInput =
  | { kind: "tagline"; chatId: number }
  | { kind: "fact"; chatId: number; factKind: string }
  | { kind: "project_field"; chatId: number; projectId: number; field: "tagline" | "stack" | "links" }
  | { kind: "new_project_name"; chatId: number }
  | { kind: "new_project_link"; chatId: number; projectId: number };

const INPUT_TTL_MS = 10 * 60 * 1000;

/** Remembers what the bot asked a user to type next in DM («Write a one-liner…»). */
export class PendingInputs {
  private readonly entries = new Map<number, { input: PendingInput; expiresAt: number }>();

  set(tgId: number, input: PendingInput): void {
    this.entries.set(tgId, { input, expiresAt: Date.now() + INPUT_TTL_MS });
  }

  take(tgId: number): PendingInput | undefined {
    const entry = this.entries.get(tgId);
    this.entries.delete(tgId);
    return entry && entry.expiresAt > Date.now() ? entry.input : undefined;
  }

  clear(tgId: number): void {
    this.entries.delete(tgId);
  }
}

/** Telegram start parameters allow only [A-Za-z0-9_-], so a group id -100123 travels as «c100123». */
export function encodeChat(chatId: number): string {
  return `c${Math.abs(chatId)}`;
}

export function decodeStartParam(param: string): { chatId: number | null; rest: string } {
  const match = /^c(\d+)(?:_(.*))?$/.exec(param);
  if (!match) return { chatId: null, rest: param };
  return { chatId: -Number(match[1]), rest: match[2] ?? "" };
}

/** The «c100123» part of callback data back to a chat id. */
export function decodeChat(encoded: string | undefined): number {
  return -Number(encoded);
}

/**
 * The message this one really replies to. Inside a forum topic every message carries the topic's first
 * message as reply_to_message, which is not a reply to its author.
 */
export function realReply(message: Message | undefined): Message["reply_to_message"] {
  const replied = message?.reply_to_message;
  if (!message || !replied) return undefined;
  if (message.is_topic_message && (replied.forum_topic_created || replied.message_id === message.message_thread_id)) return undefined;
  return replied;
}

/** Who is acting and in which chat: the group itself, or the chat picked in DM. */
export interface Scope {
  user: User;
  chatId: number;
  person: Person;
}

export interface BotKit {
  bot: Bot<BotContext>;
  sql: Sql;
  config: Config;
  pending: PendingInputs;
  membership: MembershipCache;
  identity: (from: TelegramUser, chatId?: number) => Promise<User>;
  isPrivate: (ctx: BotContext) => boolean;
  /** Owners are exactly the configured ADMIN_TG_IDS: removing an id revokes everything at the next start. */
  isOwner: (user: User) => boolean;
  /**
   * Resolves the chat a command is about. In DM with several chats and no choice yet,
   * shows a picker and returns undefined — the caller simply stops.
   */
  scope: (ctx: BotContext) => Promise<Scope | undefined>;
  /**
   * A DM button made for one chat acts on that chat, never on whichever chat is current when it is tapped.
   * Says so and returns undefined when the person is no longer in it.
   */
  scopeForChat: (ctx: BotContext, chatId: number) => Promise<Scope | undefined>;
  /**
   * The person's card in an approved chat they are in right now. Telegram's word decides: a missed leave is
   * recorded, a missed join is filled in; when Telegram can't be asked, the stored membership stands.
   */
  currentMember: (chatId: number, from: TelegramUser) => Promise<Person | undefined>;
  chatPicker: (ctx: BotContext, user: User, chats: Chat[], edit?: boolean) => Promise<unknown>;
  usersById: () => Promise<Map<number, User>>;
  appButton: (ctx: BotContext, chatId: number, label: string, path: string, startParam: string) => InlineKeyboardButton | undefined;
  show: (ctx: BotContext, html: string, keyboard?: InlineKeyboard, options?: { edit?: boolean }) => Promise<unknown>;
}

export function createKit(bot: Bot<BotContext>, sql: Sql, config: Config, membership: MembershipCache): BotKit {
  const isPrivate = (ctx: BotContext) => ctx.chat?.type === "private";
  const appUrl = (chatId: number, path: string) =>
    config.PUBLIC_URL ? `${config.PUBLIC_URL.replace(/\/$/, "")}/app/?chat=${encodeChat(chatId)}#${path}` : null;

  const show: BotKit["show"] = async (ctx, html, keyboard, options = {}) => {
    const text = clampTelegram(html);
    const common = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true }, reply_markup: keyboard };
    if (options.edit && ctx.callbackQuery?.message) {
      try {
        return await ctx.editMessageText(text, common);
      } catch (error) {
        if (String(error).includes("message is not modified")) return undefined;
        throw error;
      }
    }
    return ctx.reply(text, {
      ...common,
      reply_parameters: ctx.msg && !isPrivate(ctx) && !ctx.callbackQuery ? { message_id: ctx.msg.message_id, allow_sending_without_reply: true } : undefined,
    });
  };

  const chatPicker: BotKit["chatPicker"] = (ctx, _user, chats, edit = false) => {
    const keyboard = new InlineKeyboard();
    for (const chat of chats) keyboard.text(chat.title ?? String(chat.id), `chat:${encodeChat(chat.id)}`).row();
    return show(ctx, "🐝 <b>Which chat should I open?</b>\nYou're in several chats with Waggle — each has its own cards and chronicle.", keyboard, { edit });
  };

  const memberOf = async (chatId: number, from: TelegramUser): Promise<{ user: User; person: Person } | undefined> => {
    const user = await resolveUser(sql, from, config.ADMIN_TG_IDS);
    if (!(await isApproved(sql, chatId))) return undefined;
    const state = await membership.status(chatId, from.id);
    if (state === "left") {
      await markLeft(sql, chatId, from.id);
      return undefined;
    }
    let person = await getPerson(sql, chatId, user.id);
    if (state === "member" && (!person || person.left_at)) {
      await ensureMember(sql, chatId, user.id);
      person = await getPerson(sql, chatId, user.id);
    }
    return person && !person.left_at ? { user, person } : undefined;
  };

  return {
    bot,
    sql,
    config,
    pending: new PendingInputs(),
    membership,
    identity: (from, chatId) => resolveUser(sql, from, config.ADMIN_TG_IDS, chatId),
    isPrivate,
    isOwner: (user) => user.tg_id !== null && config.ADMIN_TG_IDS.includes(user.tg_id),
    scope: async (ctx) => {
      if (!ctx.from || !ctx.chat) return undefined;
      if (!isPrivate(ctx)) {
        const user = await resolveUser(sql, ctx.from, config.ADMIN_TG_IDS, ctx.chat.id);
        const person = await getPerson(sql, ctx.chat.id, user.id);
        return person ? { user, chatId: ctx.chat.id, person } : undefined;
      }
      const user = await resolveUser(sql, ctx.from, config.ADMIN_TG_IDS);
      let chats = await chatsOfUser(sql, user.id);
      if (chats.length === 0) {
        // Silent members never wrote, so the bot has no row for them yet — ask Telegram.
        for (const chat of await approvedChats(sql)) {
          if (await membership.isMember(chat.id, ctx.from.id)) await ensureMember(sql, chat.id, user.id);
        }
        chats = await chatsOfUser(sql, user.id);
      }
      for (;;) {
        if (chats.length === 0) {
          await show(
            ctx,
            "🐝 You're not in any chat with Waggle yet.\n\nAdd the bot to your group — once it's approved, it starts keeping the chronicle and cards there.",
          );
          return undefined;
        }
        const chat = chats.find((candidate) => candidate.id === user.current_chat_id) ?? (chats.length === 1 ? chats[0] : undefined);
        if (!chat) {
          await chatPicker(ctx, user, chats, Boolean(ctx.callbackQuery));
          return undefined;
        }
        // The stored membership may miss a leave; Telegram has the last word on the chat about to be opened.
        if ((await membership.status(chat.id, ctx.from.id)) === "left") {
          await markLeft(sql, chat.id, ctx.from.id);
          chats = chats.filter((candidate) => candidate.id !== chat.id);
          continue;
        }
        if (chat.id !== user.current_chat_id) await setCurrentChat(sql, user.id, chat.id);
        const person = await getPerson(sql, chat.id, user.id);
        return person ? { user, chatId: chat.id, person } : undefined;
      }
    },
    scopeForChat: async (ctx, chatId) => {
      if (!ctx.from) return undefined;
      const found = await memberOf(chatId, ctx.from);
      if (found) {
        // Plain navigation buttons (projects, people, chronicle) follow the chat the person is working with.
        if (found.user.current_chat_id !== chatId) await setCurrentChat(sql, found.user.id, chatId);
        return { user: found.user, chatId, person: found.person };
      }
      await show(ctx, "🐝 You're not in that chat anymore, so I can't open it. Your chats — /start", undefined, { edit: Boolean(ctx.callbackQuery?.message) });
      return undefined;
    },
    currentMember: async (chatId, from) => (await memberOf(chatId, from))?.person,
    chatPicker,
    usersById: async () => new Map((await sql<User[]>`SELECT * FROM users`).map((user) => [user.id, user])),
    appButton: (ctx, chatId, label, path, startParam) => {
      if (isPrivate(ctx)) {
        const url = appUrl(chatId, path);
        return url ? InlineKeyboard.webApp(label, url) : undefined;
      }
      if (config.BOT_APP_SHORT_NAME && bot.botInfo) {
        return InlineKeyboard.url(label, `https://t.me/${bot.botInfo.username}/${config.BOT_APP_SHORT_NAME}?startapp=${encodeChat(chatId)}_${startParam}`);
      }
      return undefined;
    },
    show,
  };
}

export function commandArgs(ctx: BotContext): string {
  return typeof ctx.match === "string" ? ctx.match.trim() : "";
}

/** Lays buttons out `perRow` to a line. */
export function grid(buttons: InlineKeyboardButton[], perRow: number): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  buttons.forEach((button, index) => {
    keyboard.add(button);
    if ((index + 1) % perRow === 0 && index + 1 < buttons.length) keyboard.row();
  });
  return keyboard;
}

export function pager(prefix: string, page: number, totalPages: number): InlineKeyboardButton[] {
  if (totalPages <= 1) return [];
  const buttons: InlineKeyboardButton[] = [];
  if (page > 0) buttons.push(InlineKeyboard.text("← Back", `${prefix}:${page - 1}`));
  buttons.push(InlineKeyboard.text(`${page + 1}/${totalPages}`, "noop"));
  if (page + 1 < totalPages) buttons.push(InlineKeyboard.text("Next →", `${prefix}:${page + 1}`));
  return buttons;
}
