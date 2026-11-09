import { Bot, GrammyError, InlineKeyboard } from "grammy";
import type { Message, User as TelegramUser } from "grammy/types";
import { allChats, approvedChats, attachLegacyData, chatsOfUser, getChat, isApproved, legacyStats, registerChat, setChatStatus, setCurrentChat } from "../core/chats.js";
import type { Config } from "../core/config.js";
import type { Sql } from "../core/db.js";
import { monthSpendUsd } from "../core/llm.js";
import { mergeSeedUser } from "../core/merge.js";
import { saveMessage, updateEditedMessage } from "../core/messages.js";
import { catchupFor } from "../core/chronicle.js";
import { escapeHtml } from "../core/text.js";
import { ensureMember, fullName, markLeft, type User } from "../core/users.js";
import { chatBudgetUsd } from "../worker/scheduler.js";
import { registerCatalog } from "./catalog.js";
import { catchupHtml, clampTelegram, formatDate, userHeader } from "./format.js";
import { commandArgs, createKit, decodeStartParam, encodeChat, type BotContext, type Scope } from "./kit.js";
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
  const membership = new MembershipCache(bot.api);
  const kit = createKit(bot, sql, config, membership);
  const isGroup = (ctx: BotContext) => ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";

  // ---------- Joining chats: a new group waits until a bot owner approves it ----------

  const chatButtons = (chatId: number) =>
    new InlineKeyboard().text("✅ Одобрить", `chatok:${encodeChat(chatId)}`).text("🚫 Отклонить", `chatno:${encodeChat(chatId)}`);

  async function askOwners(chatId: number, title: string | null, addedBy: TelegramUser | undefined) {
    const who = addedBy ? `${escapeHtml(fullName(addedBy) || addedBy.username || String(addedBy.id))}${addedBy.username ? ` @${escapeHtml(addedBy.username)}` : ""}` : "кто-то";
    const text = `🐝 Меня добавили в чат <b>${escapeHtml(title ?? String(chatId))}</b> (<code>${chatId}</code>), добавил ${who}.\nВести там летопись и карточки?`;
    for (const tgId of config.ADMIN_TG_IDS) {
      await bot.api.sendMessage(tgId, text, { parse_mode: "HTML", reply_markup: chatButtons(chatId) }).catch(() => {});
    }
  }

  async function greetApproved(chatId: number) {
    await bot.api
      .sendMessage(
        chatId,
        `🐝 Привет! Я Waggle — летописец чата. Раз в ${config.EXTRACTION_INTERVAL_HOURS} ч разбираю новые сообщения: веду летопись, карточки участников и каталог проектов. В общем чате молчу, пока не позовут. Команды — /help`,
      )
      .catch(() => {});
  }

  async function legacyOffer(chatId: number): Promise<InlineKeyboard | undefined> {
    const legacy = await legacyStats(sql);
    if (legacy.messages + legacy.members + legacy.projects === 0) return undefined;
    return new InlineKeyboard().text(
      `📥 Привязать импорт (${legacy.messages} сообщ., ${legacy.members} карточек, ${legacy.projects} проектов)`,
      `legacy:${encodeChat(chatId)}`,
    );
  }

  async function approve(chatId: number, ownerId: number | null): Promise<void> {
    await setChatStatus(sql, chatId, "approved", ownerId);
    await greetApproved(chatId);
  }

  bot.on("my_chat_member", async (ctx) => {
    if (!isGroup(ctx)) return;
    const chat = ctx.chat;
    const status = ctx.myChatMember.new_chat_member.status;
    const title = ("title" in chat ? chat.title : null) ?? null;
    if (status === "left" || status === "kicked") {
      await setChatStatus(sql, chat.id, "left", null);
      return;
    }
    const before = await getChat(sql, chat.id);
    const addedBy = ctx.from && !ctx.from.is_bot ? ctx.from : undefined;
    const adder = addedBy ? await kit.identity(addedBy) : undefined;
    const record = await registerChat(sql, chat.id, title, adder?.id ?? null);
    if (record.status === "approved") {
      if (before?.status !== "approved") await greetApproved(chat.id);
      return;
    }
    if (record.status === "rejected") {
      await ctx.leaveChat().catch(() => {});
      return;
    }
    if (adder && kit.isOwner(adder)) {
      await approve(chat.id, adder.id);
      const offer = await legacyOffer(chat.id);
      if (offer) await bot.api.sendMessage(addedBy!.id, `Чат «${title ?? chat.id}» подключён. Есть импортированная история — привязать её к этому чату?`, { reply_markup: offer }).catch(() => {});
      return;
    }
    await ctx.reply("🐝 Привет! Я Waggle, летописец чата. Жду, пока владелец бота меня одобрит — до этого ничего не читаю и не сохраняю.").catch(() => {});
    await askOwners(chat.id, title, addedBy);
  });

  // Groups: only approved chats are read. Private chats: kit.scope checks membership per screen.
  bot.use(async (ctx, next) => {
    if (!ctx.chat || ctx.myChatMember) return next();
    if (ctx.chat.type === "channel") return;
    if (!isGroup(ctx)) return ctx.from?.is_bot ? undefined : next();
    const record = await getChat(sql, ctx.chat.id);
    if (record?.status === "approved") return next();
    if (record?.status === "rejected") {
      await ctx.leaveChat().catch(() => {});
      return;
    }
    if (!record) {
      // Added before approvals existed or the join update was missed: queue it now.
      const title = ("title" in ctx.chat ? ctx.chat.title : null) ?? null;
      await registerChat(sql, ctx.chat.id, title, null);
      await askOwners(ctx.chat.id, title, undefined);
    }
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "Жду одобрения владельца бота" }).catch(() => {});
  });

  bot.callbackQuery(/^(chatok|chatno|legacy):c(\d+)$/, async (ctx) => {
    const owner = await kit.identity(ctx.from);
    if (!kit.isOwner(owner)) return ctx.answerCallbackQuery({ text: "Это решает владелец бота" });
    const chatId = -Number(ctx.match[2]);
    const record = await getChat(sql, chatId);
    if (!record) return ctx.answerCallbackQuery({ text: "Не знаю такого чата" });
    const title = escapeHtml(record.title ?? String(chatId));
    if (ctx.match[1] === "chatok") {
      await ctx.answerCallbackQuery({ text: "Одобрено" });
      if (record.status !== "approved") await approve(chatId, owner.id);
      const offer = await legacyOffer(chatId);
      return kit.show(ctx, `✅ Чат <b>${title}</b> одобрен.${offer ? "\nЕсть импортированная история — привязать её к этому чату?" : ""}`, offer, { edit: true });
    }
    if (ctx.match[1] === "chatno") {
      await ctx.answerCallbackQuery({ text: "Отклонено" });
      await setChatStatus(sql, chatId, "rejected", owner.id);
      await bot.api.leaveChat(chatId).catch(() => {});
      return kit.show(ctx, `🚫 Чат <b>${title}</b> отклонён, я из него вышел.`, undefined, { edit: true });
    }
    if (record.status !== "approved") return ctx.answerCallbackQuery({ text: "Сначала одобри чат" });
    await ctx.answerCallbackQuery({ text: "Переношу…" });
    const moved = await attachLegacyData(sql, chatId);
    await kit.show(
      ctx,
      `📥 Импорт привязан к <b>${title}</b>: ${moved.messages} сообщ., ${moved.members} карточек, ${moved.projects} проектов, ${moved.topics} тем летописи.`,
      undefined,
      { edit: true },
    );
  });

  bot.command("chats", async (ctx) => {
    if (!ctx.from || !kit.isPrivate(ctx)) return;
    const owner = await kit.identity(ctx.from);
    if (!kit.isOwner(owner)) return;
    const chats = await allChats(sql);
    if (chats.length === 0) return void (await kit.show(ctx, "Меня пока никуда не добавили. Добавь бота в группу — пришлю запрос на одобрение."));
    const labels: Record<string, string> = { pending: "⏳ ждёт", approved: "✅ работает", rejected: "🚫 отклонён", left: "👋 вышел" };
    for (const chat of chats) {
      const keyboard = chat.status === "pending" ? chatButtons(chat.id) : chat.status === "approved" ? await legacyOffer(chat.id) : undefined;
      await kit.show(ctx, `<b>${escapeHtml(chat.title ?? String(chat.id))}</b> · ${labels[chat.status]}\n<code>${chat.id}</code>`, keyboard);
    }
  });

  // ---------- Archiving: every group message is stored before commands run. It never calls the LLM ----------

  bot.on("chat_member", async (ctx) => {
    const member = ctx.chatMember.new_chat_member;
    membership.invalidate(ctx.chat.id, member.user.id);
    if (member.status === "left" || member.status === "kicked") await markLeft(sql, ctx.chat.id, member.user.id);
    else if (!member.user.is_bot) await kit.identity(member.user, ctx.chat.id);
  });

  bot.on("edited_message", async (ctx, next) => {
    const edited = ctx.editedMessage;
    if (isGroup(ctx) && edited.edit_date) {
      await updateEditedMessage(sql, ctx.chat.id, edited.message_id, messageText(edited), new Date(edited.edit_date * 1000));
    }
    return next();
  });

  bot.on("message", async (ctx, next) => {
    const message = ctx.message;
    if (isGroup(ctx)) {
      const chatId = ctx.chat.id;
      if (message.left_chat_member) {
        membership.invalidate(chatId, message.left_chat_member.id);
        await markLeft(sql, chatId, message.left_chat_member.id);
      }
      for (const joined of message.new_chat_members ?? []) {
        membership.invalidate(chatId, joined.id);
        if (!joined.is_bot) await kit.identity(joined, chatId);
      }
      if (ctx.from && !ctx.from.is_bot && !message.new_chat_members && !message.left_chat_member) {
        const isCommand = message.entities?.[0]?.type === "bot_command" && message.entities[0].offset === 0;
        const user = await kit.identity(ctx.from, chatId);
        if (!isCommand) {
          await saveMessage(sql, {
            chatId,
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

  // ---------- Switching chats in DM ----------

  const menu = () => new InlineKeyboard().text("👤 Моя карточка", "me:home").text("🏆 Проекты", "pl:top:0").row().text("📜 Летопись", "ch:3:0").text("👥 Участники", "pp:0");

  async function homeScreen(ctx: BotContext, scope: Scope, greeting: string, edit = false) {
    const chats = await chatsOfUser(sql, scope.user.id);
    const keyboard = menu();
    const app = kit.appButton(ctx, scope.chatId, "📱 Приложение", "/", "home");
    if (app) keyboard.row().add(app);
    if (chats.length > 1) keyboard.row().text("🔁 Другой чат", "chat:pick");
    const chatTitle = chats.find((chat) => chat.id === scope.chatId)?.title;
    const where = chatTitle ? `\n💬 Сейчас открыт чат <b>${escapeHtml(chatTitle)}</b>` : "";
    await kit.show(ctx, `${greeting}${where}\n\n${HELP_TEXT}`, keyboard, { edit });
  }

  /** Makes the chat from a link the current one, if the person is in it. */
  async function useChatFromParam(ctx: BotContext, chatId: number | null): Promise<void> {
    if (chatId === null || !ctx.from) return;
    const user = await kit.identity(ctx.from);
    let chats = await chatsOfUser(sql, user.id);
    if (!chats.some((chat) => chat.id === chatId) && (await isApproved(sql, chatId)) && (await membership.isMember(chatId, ctx.from.id))) {
      await ensureMember(sql, chatId, user.id);
      chats = await chatsOfUser(sql, user.id);
    }
    if (chats.some((chat) => chat.id === chatId)) await setCurrentChat(sql, user.id, chatId);
  }

  bot.callbackQuery("chat:pick", async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = await kit.identity(ctx.from);
    await kit.chatPicker(ctx, user, await chatsOfUser(sql, user.id), true);
  });

  bot.callbackQuery(/^chat:c(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await useChatFromParam(ctx, -Number(ctx.match[1]));
    const scope = await kit.scope(ctx);
    if (scope) await homeScreen(ctx, scope, "Готово 👌", true);
  });

  bot.command("start", async (ctx) => {
    if (!kit.isPrivate(ctx) || !ctx.from) return;
    const user = await kit.identity(ctx.from);
    await sql`UPDATE users SET dm_started = true WHERE id = ${user.id}`;
    const { chatId, rest: payload } = decodeStartParam(commandArgs(ctx));
    await useChatFromParam(ctx, chatId);
    const scope = await kit.scope(ctx);
    if (!scope) return;
    if (payload === "catchup") return runCatchup(ctx, scope);
    if (payload === "me") return profile.profileScreen(ctx, scope);
    if (payload.startsWith("p_")) return catalog.projectScreen(ctx, scope, payload.slice(2));
    if (payload.startsWith("u_")) return catalog.personScreen(ctx, scope, Number(payload.slice(2)));
    await homeScreen(ctx, scope, `Привет, ${escapeHtml(user.display_name)}! 👋`);
  });

  bot.command("help", (ctx) => kit.show(ctx, HELP_TEXT));

  bot.command("app", async (ctx) => {
    const scope = await kit.scope(ctx);
    if (!scope) return;
    const button = kit.appButton(ctx, scope.chatId, "📱 Открыть приложение", "/", "home");
    if (!button) return void (await kit.show(ctx, "Веб-интерфейс пока не настроен — всё доступно командами, см. /help"));
    await kit.show(ctx, "Люди, проекты и летопись — в приложении:", new InlineKeyboard().add(button));
  });

  async function runCatchup(ctx: BotContext, scope: Scope, hours?: number) {
    const data = await catchupFor(sql, scope.chatId, scope.person, hours);
    const html = catchupHtml(data, await kit.usersById(), scope.chatId, config.EXTRACTION_INTERVAL_HOURS, config.DISPLAY_TIMEZONE);
    const keyboard = new InlineKeyboard().text("📜 Вся летопись", "ch:3:0");
    await ctx.api.sendMessage(scope.user.tg_id!, clampTelegram(html), { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: keyboard });
  }

  bot.command("catchup", async (ctx) => {
    if (!ctx.from) return;
    const scope = await kit.scope(ctx);
    if (!scope) return;
    const hours = Number.parseInt(commandArgs(ctx), 10);
    const sinceHours = Number.isFinite(hours) && hours > 0 ? Math.min(hours, 168) : undefined;
    if (kit.isPrivate(ctx)) return runCatchup(ctx, scope, sinceHours);
    // The DM opens this chat's catch-up, so switch the person's current chat to it.
    await setCurrentChat(sql, scope.user.id, scope.chatId);
    const openBot = new InlineKeyboard().url("Открыть бота", `https://t.me/${bot.botInfo.username}?start=${encodeChat(scope.chatId)}_catchup`);
    if (!scope.user.dm_started) return void (await kit.show(ctx, "Выжимку пришлю в личку — сначала открой бота 👇", openBot));
    await ctx.react("👌").catch(() => {});
    try {
      await runCatchup(ctx, scope, sinceHours);
    } catch (error) {
      if (error instanceof GrammyError && error.error_code === 403) {
        await sql`UPDATE users SET dm_started = false WHERE id = ${scope.user.id}`;
        return void (await kit.show(ctx, "Не могу написать в личку — открой бота 👇", openBot));
      }
      throw error;
    }
  });

  bot.command("link", async (ctx) => {
    if (!ctx.from || !isGroup(ctx)) return;
    const admin = await kit.identity(ctx.from, ctx.chat.id);
    if (!kit.isOwner(admin)) return;
    const target = ctx.msg?.reply_to_message?.from;
    const seedName = commandArgs(ctx);
    if (!target || !seedName) return void (await kit.show(ctx, "Ответь на сообщение человека: /link Имя из стартовых карточек"));
    const into = await kit.identity(target, ctx.chat.id);
    const [seed] = await sql<User[]>`
      SELECT u.* FROM users u JOIN members m ON m.user_id = u.id
      WHERE u.tg_id IS NULL AND m.chat_id = ${ctx.chat.id} AND lower(u.display_name) = lower(${seedName})`;
    if (!seed) return void (await kit.show(ctx, `Нет непривязанной карточки «${escapeHtml(seedName)}»`));
    await mergeSeedUser(sql, seed.id, into.id, admin.id);
    await kit.show(ctx, `Привязал карточку «${escapeHtml(seed.display_name)}» к ${userHeader(into)} ✅`);
  });

  bot.command("botstatus", async (ctx) => {
    if (!ctx.from || !kit.isPrivate(ctx)) return;
    const user = await kit.identity(ctx.from);
    if (!kit.isOwner(user)) return;
    const lines = ["<b>Состояние</b>", `Летописец: раз в ${config.EXTRACTION_INTERVAL_HOURS} ч`];
    for (const chat of await approvedChats(sql)) {
      const [last] = await sql<{ at: Date | null; status: string; error: string | null; messages_count: number }[]>`
        SELECT finished_at AS at, status, error, messages_count FROM extraction_runs WHERE chat_id = ${chat.id} ORDER BY id DESC LIMIT 1`;
      const [counts] = await sql<{ members: number; facts: number; projects: number; messages: number; pending: number; topics: number; unlinked: string[] | null }[]>`
        SELECT (SELECT count(*)::int FROM members WHERE chat_id = ${chat.id} AND left_at IS NULL) AS members,
               (SELECT count(*)::int FROM facts WHERE chat_id = ${chat.id} AND status IN ('auto', 'manual')) AS facts,
               (SELECT count(*)::int FROM projects WHERE chat_id = ${chat.id} AND NOT hidden) AS projects,
               (SELECT count(*)::int FROM messages WHERE chat_id = ${chat.id}) AS messages,
               (SELECT count(*)::int FROM messages WHERE chat_id = ${chat.id} AND extracted_at IS NULL) AS pending,
               (SELECT count(*)::int FROM chronicle WHERE chat_id = ${chat.id}) AS topics,
               (SELECT array_agg(u.display_name ORDER BY u.display_name) FROM users u JOIN members m ON m.user_id = u.id
                WHERE m.chat_id = ${chat.id} AND u.tg_id IS NULL) AS unlinked`;
      const spent = await monthSpendUsd(sql, chat.id);
      const budget = chatBudgetUsd(chat, config.CHAT_MONTHLY_BUDGET_USD);
      const lastLine = last
        ? `${last.at ? formatDate(last.at, config.DISPLAY_TIMEZONE) : "идёт сейчас"} · ${last.status} · ${last.messages_count} сообщ.${last.error ? `\n⚠️ ${escapeHtml(last.error)}` : ""}`
        : "ещё не было";
      lines.push(
        "",
        `💬 <b>${escapeHtml(chat.title ?? String(chat.id))}</b>`,
        `Сообщений: ${counts?.messages}, ждут летописца: ${counts?.pending}. Последний проход — ${lastLine}`,
        `Участников: ${counts?.members}, фактов: ${counts?.facts}, проектов: ${counts?.projects}, тем: ${counts?.topics}`,
        counts?.unlinked?.length ? `Непривязанные карточки: ${counts.unlinked.map(escapeHtml).join(", ")} — реплаем /link Имя` : "Все карточки привязаны",
        `Нейронка за месяц: $${spent.toFixed(3)} из $${budget.toFixed(2)}`,
      );
    }
    lines.push("", `Всего на нейронку за месяц: $${(await monthSpendUsd(sql)).toFixed(3)} из $${config.MONTHLY_LLM_BUDGET_USD}`);
    const pending = (await allChats(sql)).filter((chat) => chat.status === "pending").length;
    if (pending) lines.push(`⏳ Чатов ждёт одобрения: ${pending} — /chats`);
    await kit.show(ctx, lines.join("\n"));
  });

  // Plain text in DM is the answer to a question the bot asked; otherwise show the menu. Mentions in a group get help.
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return;
    if (kit.isPrivate(ctx)) {
      const input = kit.pending.take(ctx.from.id);
      if (input) return profile.handleInput(ctx, input, text);
      const scope = await kit.scope(ctx);
      if (scope) await kit.show(ctx, "Выбери, что открыть, или посмотри /help 👇", menu());
      return;
    }
    const username = bot.botInfo.username;
    if (text.toLowerCase().includes(`@${username.toLowerCase()}`)) await kit.show(ctx, HELP_TEXT);
  });

  bot.catch((error) => {
    console.error(`[bot] update ${error.ctx.update.update_id} failed:`, error.error);
    if (error.ctx.callbackQuery) void error.ctx.answerCallbackQuery({ text: "Что-то пошло не так 😕" }).catch(() => {});
  });

  return { bot, membership };
}

const OWNER_COMMANDS = [
  ...PRIVATE_COMMANDS,
  { command: "chats", description: "Чаты бота: одобрить, привязать импорт" },
  { command: "botstatus", description: "Состояние летописца и бюджет" },
];

export async function registerCommands(bot: Bot<BotContext>, ownerTgIds: number[]): Promise<void> {
  await bot.api.setMyCommands(GROUP_COMMANDS, { scope: { type: "all_group_chats" } });
  await bot.api.setMyCommands(PRIVATE_COMMANDS, { scope: { type: "all_private_chats" } });
  for (const tgId of ownerTgIds) {
    await bot.api.setMyCommands(OWNER_COMMANDS, { scope: { type: "chat", chat_id: tgId } }).catch(() => {});
  }
}

export async function notifyAdmins(bot: Bot<BotContext>, sql: Sql, adminTgIds: number[], text: string): Promise<void> {
  const fromDb = (await sql<{ tg_id: number }[]>`SELECT tg_id FROM users WHERE is_admin AND tg_id IS NOT NULL`).map((row) => row.tg_id);
  for (const tgId of new Set([...adminTgIds, ...fromDb])) {
    await bot.api.sendMessage(tgId, text).catch(() => {});
  }
}

export const ALLOWED_UPDATES = ["message", "edited_message", "callback_query", "chat_member", "my_chat_member"] as const;
