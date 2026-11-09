import { Bot, GrammyError, InlineKeyboard } from "grammy";
import type { Message } from "grammy/types";
import type { Config } from "../core/config.js";
import type { Sql } from "../core/db.js";
import { monthSpendUsd } from "../core/llm.js";
import { mergeSeedUser } from "../core/merge.js";
import { saveMessage, updateEditedMessage } from "../core/messages.js";
import { catchupFor } from "../core/chronicle.js";
import { escapeHtml } from "../core/text.js";
import { markLeft, type User } from "../core/users.js";
import { registerCatalog } from "./catalog.js";
import { catchupHtml, clampTelegram, formatDate, userHeader } from "./format.js";
import { commandArgs, createKit, type BotContext } from "./kit.js";
import { MembershipCache } from "./membership.js";
import { registerProfile } from "./profile.js";

export interface BotDeps {
  sql: Sql;
  config: Config;
}

const GROUP_COMMANDS = [
  { command: "who", description: "Кто это? /who @ник или реплаем" },
  { command: "people", description: "Все участники" },
  { command: "top", description: "Рейтинг проектов" },
  { command: "chronicle", description: "Летопись: о чём говорили" },
  { command: "catchup", description: "Что я пропустил (в личку)" },
  { command: "whoknows", description: "Кто шарит в теме" },
  { command: "links", description: "Ссылки из чата" },
  { command: "help", description: "Что умеет бот" },
];

const PRIVATE_COMMANDS = [
  { command: "me", description: "Моя карточка" },
  { command: "catchup", description: "Что я пропустил" },
  { command: "chronicle", description: "Летопись" },
  { command: "people", description: "Участники" },
  { command: "top", description: "Рейтинг проектов" },
  { command: "whoknows", description: "Кто шарит в теме" },
  { command: "links", description: "Ссылки из чата" },
  { command: "addproject", description: "Добавить свой проект" },
  { command: "whatyouknow", description: "Что бот знает обо мне" },
  { command: "forgetme", description: "Удалить всё обо мне" },
  { command: "help", description: "Что умеет бот" },
];

const HELP_TEXT = [
  "🐝 <b>Waggle — летописец чата</b>",
  "",
  "Я читаю чат, веду летопись, карточки участников и каталог проектов. В общем чате молчу, пока не позовут.",
  "",
  "<b>Люди</b>",
  "/me — твоя карточка: поправить, добавить, скрыть",
  "/who @ник — кто это (или ответь командой на сообщение)",
  "/people — все участники",
  "/whoknows тема — кто разбирается в теме",
  "",
  "<b>Проекты</b>",
  "/top — рейтинг проектов чата",
  "/project название — карточка проекта, голос 👍",
  "/addproject ссылка описание — добавить свой",
  "",
  "<b>Чат</b>",
  "/catchup — что ты пропустил (приходит в личку; /catchup 12 — за 12 часов)",
  "/chronicle — летопись: о чём говорили",
  "/links — ссылки из чата",
  "",
  "<b>Приватность</b>",
  "/whatyouknow — всё, что я о тебе знаю · /forgetme — удалить",
].join("\n");

function mediaTypeOf(message: Message): string | null {
  if (message.photo) return "фото";
  if (message.video) return "видео";
  if (message.video_note) return "кружок";
  if (message.voice) return "голосовое";
  if (message.audio) return "аудио";
  if (message.document) return "файл";
  if (message.sticker) return "стикер";
  if (message.animation) return "гифка";
  if (message.poll) return "опрос";
  return null;
}

function forwardSourceOf(message: Message): string | null {
  const origin = message.forward_origin;
  if (!origin) return null;
  if (origin.type === "channel") return origin.chat.title ?? null;
  if (origin.type === "chat") return origin.sender_chat.title ?? null;
  if (origin.type === "user") return [origin.sender_user.first_name, origin.sender_user.last_name].filter(Boolean).join(" ");
  return origin.sender_user_name;
}

function messageText(message: Message): string {
  return (message.text ?? message.caption ?? message.poll?.question ?? "").trim();
}

export function createBot(deps: BotDeps): { bot: Bot<BotContext>; membership: MembershipCache } {
  const { sql, config } = deps;
  const bot = new Bot<BotContext>(config.BOT_TOKEN);
  const membership = new MembershipCache(bot.api, config.CHAT_ID);
  const kit = createKit(bot, sql, config);

  // Only the configured chat and its members may use the bot.
  bot.use(async (ctx, next) => {
    const chat = ctx.chat;
    if (!chat) return next();
    if (chat.type === "group" || chat.type === "supergroup") {
      if (config.CHAT_ID === 0) {
        console.log(`[setup] group «${chat.title}» → CHAT_ID=${chat.id}`);
        if (ctx.message || ctx.myChatMember) {
          await ctx.reply(`👋 Режим настройки. ID этой группы: <code>${chat.id}</code>\nВпиши его в .env как CHAT_ID=${chat.id} и перезапусти бота.`, { parse_mode: "HTML" }).catch(() => {});
        }
        return;
      }
      if (chat.id !== config.CHAT_ID) {
        await ctx.leaveChat().catch(() => {});
        return;
      }
      return next();
    }
    if (chat.type === "private" && ctx.from && !ctx.from.is_bot) {
      if (config.CHAT_ID === 0) {
        if (ctx.message) await ctx.reply(`Бот в режиме настройки: добавь меня в группу, и я покажу её ID для CHAT_ID.\nТвой Telegram ID: ${ctx.from.id} (для ADMIN_TG_IDS).`);
        return;
      }
      if (!(await membership.isMember(ctx.from.id))) {
        if (ctx.message) await ctx.reply("Я работаю только для участников нашего чата 🐝");
        else if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "Только для участников чата" });
        return;
      }
      return next();
    }
  });

  bot.on("chat_member", async (ctx) => {
    if (!kit.isMainChat(ctx)) return;
    const member = ctx.chatMember.new_chat_member;
    membership.invalidate(member.user.id);
    if (member.status === "left" || member.status === "kicked") await markLeft(sql, member.user.id);
    else if (!member.user.is_bot) await kit.identity(member.user);
  });

  bot.on("edited_message", async (ctx, next) => {
    const edited = ctx.editedMessage;
    if (kit.isMainChat(ctx) && edited.edit_date) {
      await updateEditedMessage(sql, config.CHAT_ID, edited.message_id, messageText(edited), new Date(edited.edit_date * 1000));
    }
    return next();
  });

  // Archive every group message before commands run. Archiving never calls the LLM.
  bot.on("message", async (ctx, next) => {
    const message = ctx.message;
    if (kit.isMainChat(ctx)) {
      if (message.left_chat_member) await markLeft(sql, message.left_chat_member.id);
      if (ctx.from && !ctx.from.is_bot && !message.new_chat_members && !message.left_chat_member) {
        const isCommand = message.entities?.[0]?.type === "bot_command" && message.entities[0].offset === 0;
        const user = await kit.identity(ctx.from);
        if (!isCommand) {
          await saveMessage(sql, {
            chatId: config.CHAT_ID,
            msgId: message.message_id,
            userId: user.id,
            sentAt: new Date(message.date * 1000),
            text: messageText(message),
            replyToMsgId: message.reply_to_message?.message_id ?? null,
            isForward: Boolean(message.forward_origin),
            forwardSource: forwardSourceOf(message),
            mediaType: mediaTypeOf(message),
          });
        }
      }
    }
    return next();
  });

  bot.on("message:text", async (ctx, next) => {
    if (kit.isPrivate(ctx) && ctx.message.text.startsWith("/")) kit.pending.clear(ctx.from.id);
    return next();
  });

  const profile = registerProfile(kit);
  const catalog = registerCatalog(kit);

  bot.command("start", async (ctx) => {
    if (!kit.isPrivate(ctx) || !ctx.from) return;
    const user = await kit.identity(ctx.from);
    await sql`UPDATE users SET dm_started = true WHERE id = ${user.id}`;
    const payload = commandArgs(ctx);
    if (payload === "catchup") return runCatchup(ctx, user);
    if (payload === "me") return profile.profileScreen(ctx, user);
    if (payload.startsWith("p_")) return catalog.projectScreen(ctx, payload.slice(2));
    if (payload.startsWith("u_")) return catalog.personScreen(ctx, Number(payload.slice(2)));
    const keyboard = menu();
    const app = kit.appButton(ctx, "📱 Приложение", "/", "home");
    if (app) keyboard.row().add(app);
    await kit.show(ctx, `Привет, ${escapeHtml(user.display_name)}! 👋\n\n${HELP_TEXT}`, keyboard);
  });

  bot.command("help", (ctx) => kit.show(ctx, HELP_TEXT));

  bot.command("app", async (ctx) => {
    const button = kit.appButton(ctx, "📱 Открыть приложение", "/", "home");
    if (!button) return void (await kit.show(ctx, "Веб-интерфейс пока не настроен — всё доступно командами, см. /help"));
    await kit.show(ctx, "Люди, проекты и поиск — в приложении:", new InlineKeyboard().add(button));
  });

  async function runCatchup(ctx: BotContext, user: User, hours?: number) {
    const data = await catchupFor(sql, config.CHAT_ID, user, hours);
    const html = catchupHtml(data, await kit.usersById(), config.CHAT_ID, config.EXTRACTION_INTERVAL_HOURS, config.DISPLAY_TIMEZONE);
    const keyboard = new InlineKeyboard().text("📜 Вся летопись", "ch:3:0");
    await ctx.api.sendMessage(user.tg_id!, clampTelegram(html), { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: keyboard });
  }

  bot.command("catchup", async (ctx) => {
    if (!ctx.from) return;
    const user = await kit.identity(ctx.from);
    const hours = Number.parseInt(commandArgs(ctx), 10);
    const sinceHours = Number.isFinite(hours) && hours > 0 ? Math.min(hours, 168) : undefined;
    if (kit.isPrivate(ctx)) return runCatchup(ctx, user, sinceHours);
    const openBot = new InlineKeyboard().url("Открыть бота", `https://t.me/${bot.botInfo.username}?start=catchup`);
    if (!user.dm_started) return void (await kit.show(ctx, "Выжимку пришлю в личку — сначала открой бота 👇", openBot));
    await ctx.react("👌").catch(() => {});
    try {
      await runCatchup(ctx, user, sinceHours);
    } catch (error) {
      if (error instanceof GrammyError && error.error_code === 403) {
        await sql`UPDATE users SET dm_started = false WHERE id = ${user.id}`;
        return void (await kit.show(ctx, "Не могу написать в личку — открой бота 👇", openBot));
      }
      throw error;
    }
  });

  bot.command("link", async (ctx) => {
    if (!ctx.from) return;
    const admin = await kit.identity(ctx.from);
    if (!admin.is_admin) return;
    const target = ctx.msg?.reply_to_message?.from;
    const seedName = commandArgs(ctx);
    if (!target || !seedName) return void (await kit.show(ctx, "Ответь на сообщение человека: /link Имя из стартовых карточек"));
    const into = await kit.identity(target);
    const [seed] = await sql<User[]>`SELECT * FROM users WHERE tg_id IS NULL AND lower(display_name) = lower(${seedName})`;
    if (!seed) return void (await kit.show(ctx, `Нет непривязанной карточки «${escapeHtml(seedName)}»`));
    await mergeSeedUser(sql, seed.id, into.id, admin.id);
    await kit.show(ctx, `Привязал карточку «${escapeHtml(seed.display_name)}» к ${userHeader(into)} ✅`);
  });

  bot.command("botstatus", async (ctx) => {
    if (!ctx.from || !kit.isPrivate(ctx)) return;
    const user = await kit.identity(ctx.from);
    if (!user.is_admin) return;
    const [pending] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM messages WHERE extracted_at IS NULL`;
    const [last] = await sql<{ at: Date | null; status: string; error: string | null; messages_count: number }[]>`
      SELECT finished_at AS at, status, error, messages_count FROM extraction_runs ORDER BY id DESC LIMIT 1`;
    const [counts] = await sql<{ users: number; facts: number; projects: number; messages: number; unlinked: string[] | null; topics: number; signals: number }[]>`
      SELECT (SELECT count(*)::int FROM users WHERE left_at IS NULL) AS users,
             (SELECT count(*)::int FROM facts WHERE status IN ('auto', 'manual')) AS facts,
             (SELECT count(*)::int FROM projects WHERE NOT hidden) AS projects,
             (SELECT count(*)::int FROM messages) AS messages,
             (SELECT array_agg(display_name ORDER BY display_name) FROM users WHERE tg_id IS NULL) AS unlinked,
             (SELECT count(*)::int FROM chronicle) AS topics,
             (SELECT count(*)::int FROM project_signals) AS signals`;
    const spent = await monthSpendUsd(sql);
    const lastLine = last
      ? `${last.at ? formatDate(last.at, config.DISPLAY_TIMEZONE) : "идёт сейчас"} · ${last.status} · ${last.messages_count} сообщ.${last.error ? `\n⚠️ ${escapeHtml(last.error)}` : ""}`
      : "ещё не было";
    await kit.show(
      ctx,
      [
        "<b>Состояние</b>",
        `Сообщений в архиве: ${counts?.messages}, ждут летописца: ${pending?.count}`,
        `Летописец: раз в ${config.EXTRACTION_INTERVAL_HOURS} ч, последний проход — ${lastLine}`,
        `Участников: ${counts?.users}, фактов: ${counts?.facts}, проектов: ${counts?.projects}, тем в летописи: ${counts?.topics}, сигналов по проектам: ${counts?.signals}`,
        counts?.unlinked?.length ? `Непривязанные стартовые карточки: ${counts.unlinked.map(escapeHtml).join(", ")} — привяжи реплаем /link Имя` : "Все стартовые карточки привязаны",
        `Нейронка за месяц: $${spent.toFixed(3)} из $${config.MONTHLY_LLM_BUDGET_USD}`,
      ].join("\n"),
    );
  });

  // Plain text in DM is the answer to a question the bot asked; otherwise show the menu. Mentions in the group get help.
  const menu = () => new InlineKeyboard().text("👤 Моя карточка", "me:home").text("🏆 Проекты", "pl:top:0").row().text("📜 Летопись", "ch:3:0").text("👥 Участники", "pp:0");
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return;
    if (kit.isPrivate(ctx)) {
      const input = kit.pending.take(ctx.from.id);
      if (input) return profile.handleInput(ctx, input, text);
      return void (await kit.show(ctx, "Выбери, что открыть, или посмотри /help 👇", menu()));
    }
    const username = bot.botInfo.username;
    if (kit.isMainChat(ctx) && text.toLowerCase().includes(`@${username.toLowerCase()}`)) await kit.show(ctx, HELP_TEXT);
  });

  bot.catch((error) => {
    console.error(`[bot] update ${error.ctx.update.update_id} failed:`, error.error);
    if (error.ctx.callbackQuery) void error.ctx.answerCallbackQuery({ text: "Что-то пошло не так 😕" }).catch(() => {});
  });

  return { bot, membership };
}

export async function registerCommands(bot: Bot<BotContext>): Promise<void> {
  await bot.api.setMyCommands(GROUP_COMMANDS, { scope: { type: "all_group_chats" } });
  await bot.api.setMyCommands(PRIVATE_COMMANDS, { scope: { type: "all_private_chats" } });
}

export async function notifyAdmins(bot: Bot<BotContext>, sql: Sql, adminTgIds: number[], text: string): Promise<void> {
  const fromDb = (await sql<{ tg_id: number }[]>`SELECT tg_id FROM users WHERE is_admin AND tg_id IS NOT NULL`).map((row) => row.tg_id);
  for (const tgId of new Set([...adminTgIds, ...fromDb])) {
    await bot.api.sendMessage(tgId, text).catch(() => {});
  }
}

export const ALLOWED_UPDATES = ["message", "edited_message", "callback_query", "chat_member", "my_chat_member"] as const;
