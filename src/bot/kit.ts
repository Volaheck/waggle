import { InlineKeyboard, type Bot, type Context } from "grammy";
import type { InlineKeyboardButton, User as TelegramUser } from "grammy/types";
import type { Config } from "../core/config.js";
import type { Sql } from "../core/db.js";
import { resolveUser, type User } from "../core/users.js";
import { clampTelegram } from "./format.js";

export type BotContext = Context;

export type PendingInput =
  | { kind: "tagline" }
  | { kind: "fact"; factKind: string }
  | { kind: "project_field"; projectId: number; field: "tagline" | "stack" | "links" }
  | { kind: "new_project_name" }
  | { kind: "new_project_link"; projectId: number };

const INPUT_TTL_MS = 10 * 60 * 1000;

/** Remembers what the bot asked a user to type next in DM («Напиши однострочник…»). */
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

export interface BotKit {
  bot: Bot<BotContext>;
  sql: Sql;
  config: Config;
  pending: PendingInputs;
  identity: (from: TelegramUser) => Promise<User>;
  isPrivate: (ctx: BotContext) => boolean;
  isMainChat: (ctx: BotContext) => boolean;
  usersById: () => Promise<Map<number, User>>;
  appButton: (ctx: BotContext, label: string, path: string, startParam: string) => InlineKeyboardButton | undefined;
  show: (ctx: BotContext, html: string, keyboard?: InlineKeyboard, options?: { edit?: boolean }) => Promise<unknown>;
}

export function createKit(bot: Bot<BotContext>, sql: Sql, config: Config): BotKit {
  const isPrivate = (ctx: BotContext) => ctx.chat?.type === "private";
  const appUrl = (path: string) => (config.PUBLIC_URL ? `${config.PUBLIC_URL.replace(/\/$/, "")}/app/#${path}` : null);

  return {
    bot,
    sql,
    config,
    pending: new PendingInputs(),
    identity: (from) => resolveUser(sql, from, config.ADMIN_TG_IDS),
    isPrivate,
    isMainChat: (ctx) => ctx.chat?.id === config.CHAT_ID,
    usersById: async () => new Map((await sql<User[]>`SELECT * FROM users`).map((user) => [user.id, user])),
    appButton: (ctx, label, path, startParam) => {
      if (isPrivate(ctx)) {
        const url = appUrl(path);
        return url ? InlineKeyboard.webApp(label, url) : undefined;
      }
      if (config.BOT_APP_SHORT_NAME && bot.botInfo) {
        return InlineKeyboard.url(label, `https://t.me/${bot.botInfo.username}/${config.BOT_APP_SHORT_NAME}?startapp=${startParam}`);
      }
      return undefined;
    },
    show: async (ctx, html, keyboard, options = {}) => {
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
    },
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
  if (page > 0) buttons.push(InlineKeyboard.text("← Назад", `${prefix}:${page - 1}`));
  buttons.push(InlineKeyboard.text(`${page + 1}/${totalPages}`, "noop"));
  if (page + 1 < totalPages) buttons.push(InlineKeyboard.text("Дальше →", `${prefix}:${page + 1}`));
  return buttons;
}
