import { Bot, GrammyError, InlineKeyboard } from "grammy";
import type { Message, User as TelegramUser } from "grammy/types";
import { migrateChat } from "../core/chat-migration.js";
import { allChats, approvedChats, attachLegacyData, chatsOfUser, getChat, isApproved, legacyStats, registerChat, setChatStatus, setCurrentChat } from "../core/chats.js";
import type { Config } from "../core/config.js";
import type { Sql } from "../core/db.js";
import { monthSpendUsd } from "../core/llm.js";
import { mergeSeedUser } from "../core/merge.js";
import { saveMessage, updateEditedMessage } from "../core/messages.js";
import { catchupFor } from "../core/chronicle.js";
import { escapeHtml } from "../core/text.js";
import { ensureMember, fullName, markLeft, SERVICE_TG_IDS, type User } from "../core/users.js";
import { nextConsolidationRetryAt } from "../worker/consolidate.js";
import { chatBudgetUsd, nextExtractionRetryAt } from "../worker/scheduler.js";
import { registerCatalog } from "./catalog.js";
import { catchupHtml, clampTelegram, countOf, formatDate, userHeader } from "./format.js";
import { commandArgs, createKit, decodeStartParam, encodeChat, realReply, type BotContext, type Scope } from "./kit.js";
import { isInChat, MembershipCache } from "./membership.js";
import { registerProfile } from "./profile.js";

export interface BotDeps {
  sql: Sql;
  config: Config;
}

const GROUP_COMMANDS = [
  { command: "who", description: "Who's this? /who @username or as a reply" },
  { command: "people", description: "All members" },
  { command: "top", description: "Project rating" },
  { command: "chronicle", description: "Chronicle: what people talked about" },
  { command: "catchup", description: "What I missed (sent to DM)" },
  { command: "whoknows", description: "Who knows a topic" },
  { command: "help", description: "What the bot can do" },
];

const PRIVATE_COMMANDS = [
  { command: "me", description: "My card" },
  { command: "catchup", description: "What I missed" },
  { command: "chronicle", description: "Chronicle" },
  { command: "people", description: "Members" },
  { command: "top", description: "Project rating" },
  { command: "whoknows", description: "Who knows a topic" },
  { command: "addproject", description: "Add your project" },
  { command: "whatyouknow", description: "What the bot knows about me" },
  { command: "forgetme", description: "Delete everything about me" },
  { command: "help", description: "What the bot can do" },
];

const HELP_TEXT = [
  "🐝 <b>Waggle — the chat's chronicler</b>",
  "",
  "I read the chat and keep a chronicle, member cards and a project catalog. In the group I stay quiet until someone calls me.",
  "",
  "<b>People</b>",
  "/me — your card: fix, add, hide",
  "/who @username — who this is (or reply to a message with the command)",
  "/people — all members",
  "/whoknows topic — who knows the topic",
  "",
  "<b>Projects</b>",
  "/top — the chat's project rating",
  "/project name — project card, 👍 vote",
  "/addproject link description — add yours",
  "",
  "<b>Chat</b>",
  "/catchup — what you missed (sent to DM; /catchup 12 — last 12 hours)",
  "/chronicle — chronicle: what people talked about",
  "",
  "<b>Privacy</b>",
  "/whatyouknow — everything I know about you · /forgetme — delete it",
].join("\n");

function mediaTypeOf(message: Message): string | null {
  if (message.photo) return "photo";
  if (message.video) return "video";
  if (message.video_note) return "video note";
  if (message.voice) return "voice";
  if (message.audio) return "audio";
  // A GIF also carries `document`, so it has to be recognized first.
  if (message.animation) return "GIF";
  if (message.document) return "file";
  if (message.sticker) return "sticker";
  if (message.poll) return "poll";
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

/** Notes about the chat itself (an upgrade to a supergroup, forum topics) are not conversation. */
function isChatServiceNote(message: Message): boolean {
  return Boolean(
    message.migrate_to_chat_id ||
      message.migrate_from_chat_id ||
      message.forum_topic_created ||
      message.forum_topic_edited ||
      message.forum_topic_closed ||
      message.forum_topic_reopened ||
      message.general_forum_topic_hidden ||
      message.general_forum_topic_unhidden,
  );
}

/** Posts of a linked channel, anonymous admins and channel identities have no person behind them. */
function isAnonymousPost(message: Message, from: TelegramUser | undefined): boolean {
  return Boolean(message.sender_chat || message.is_automatic_forward) || (from !== undefined && SERVICE_TG_IDS.includes(from.id));
}

/** The group a failed call was about and the supergroup it became, when Telegram says it was upgraded. */
function upgradeOf(error: unknown, fallbackChatId?: number): { from: number; to: number } | undefined {
  if (!(error instanceof GrammyError) || error.parameters.migrate_to_chat_id === undefined) return undefined;
  const from = typeof error.payload.chat_id === "number" ? error.payload.chat_id : fallbackChatId;
  return from === undefined ? undefined : { from, to: error.parameters.migrate_to_chat_id };
}

export function createBot(deps: BotDeps): { bot: Bot<BotContext>; membership: MembershipCache } {
  const { sql, config } = deps;
  const bot = new Bot<BotContext>(config.BOT_TOKEN);
  const membership = new MembershipCache(bot.api);
  const kit = createKit(bot, sql, config, membership);
  const isGroup = (ctx: BotContext) => ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";

  // ---------- Joining chats: a new group waits until a bot owner approves it ----------

  const chatButtons = (chatId: number) =>
    new InlineKeyboard().text("✅ Approve", `chatok:${encodeChat(chatId)}`).text("🚫 Reject", `chatno:${encodeChat(chatId)}`);

  async function askOwners(chatId: number, title: string | null, addedBy: TelegramUser | undefined) {
    const who = addedBy ? `${escapeHtml(fullName(addedBy) || addedBy.username || String(addedBy.id))}${addedBy.username ? ` @${escapeHtml(addedBy.username)}` : ""}` : "someone";
    const text = `🐝 I was added to the chat <b>${escapeHtml(title ?? String(chatId))}</b> (<code>${chatId}</code>) by ${who}.\nShould I keep the chronicle and cards there?`;
    for (const tgId of config.ADMIN_TG_IDS) {
      await bot.api.sendMessage(tgId, text, { parse_mode: "HTML", reply_markup: chatButtons(chatId) }).catch(() => {});
    }
  }

  const greeting = () =>
    `🐝 Hi! I'm Waggle, the chat's chronicler. Every ${config.EXTRACTION_INTERVAL_HOURS} h I go through new messages and keep a chronicle, member cards and a project catalog. In the group I stay quiet until someone calls me. Commands — /help`;

  async function greetApproved(chatId: number) {
    await bot.api
      .sendMessage(chatId, greeting())
      .catch(async (error) => {
        // An approval tapped for a group that has meanwhile become a supergroup goes to the supergroup.
        const upgrade = upgradeOf(error, chatId);
        if (!upgrade) return;
        await followMigration(upgrade.from, upgrade.to, null);
        if ((await getChat(sql, upgrade.to))?.status === "approved") await bot.api.sendMessage(upgrade.to, greeting()).catch(() => {});
      })
      .catch((error) => console.error(`[bot] could not greet ${chatId}:`, error));
  }

  /**
   * A basic group became a supergroup: its approval and data move to the new id (see migrateChat).
   * The first of the two announcements tells the owners; a new id that ends up pending is put to them again.
   */
  async function followMigration(oldChatId: number, newChatId: number, title: string | null): Promise<void> {
    const result = await migrateChat(sql, oldChatId, newChatId);
    if (!result.firstRun) return;
    const name = result.chat?.title ?? title;
    if (result.carried === null) {
      if (!result.chat) {
        await registerChat(sql, newChatId, title, null);
        await askOwners(newChatId, title, undefined);
      }
      return;
    }
    if (result.chat?.status === "approved") {
      const text = `🐝 The chat <b>${escapeHtml(name ?? String(newChatId))}</b> became a supergroup (<code>${newChatId}</code>). Its chronicle, cards and projects moved along with it.`;
      for (const tgId of config.ADMIN_TG_IDS) await bot.api.sendMessage(tgId, text, { parse_mode: "HTML" }).catch(() => {});
    } else if (result.chat?.status === "pending") {
      await askOwners(newChatId, name, undefined);
    } else if (result.chat?.status === "rejected") {
      await bot.api.leaveChat(newChatId).catch(() => {});
    }
  }

  async function legacyOffer(chatId: number): Promise<InlineKeyboard | undefined> {
    const legacy = await legacyStats(sql);
    if (legacy.messages + legacy.members + legacy.projects === 0) return undefined;
    return new InlineKeyboard().text(
      `📥 Attach import (${countOf(legacy.messages, "message")}, ${countOf(legacy.members, "card")}, ${countOf(legacy.projects, "project")})`,
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
      // The bot leaves a rejected chat itself; that must not turn the rejection into a plain "left".
      await sql`UPDATE chats SET status = 'left' WHERE id = ${chat.id} AND status <> 'rejected'`;
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
      if (offer) await bot.api.sendMessage(addedBy!.id, `Chat “${title ?? chat.id}” is connected. There's imported history — attach it to this chat?`, { reply_markup: offer }).catch(() => {});
      return;
    }
    await ctx.reply("🐝 Hi! I'm Waggle, the chat's chronicler. I'm waiting for the bot owner to approve me — until then I don't read or save anything.").catch(() => {});
    await askOwners(chat.id, title, addedBy);
  });

  // Groups: only approved chats are read. Private chats: kit.scope checks membership per screen.
  bot.use(async (ctx, next) => {
    if (!ctx.chat || ctx.myChatMember) return next();
    if (ctx.chat.type === "channel") return;
    if (!isGroup(ctx)) return ctx.from?.is_bot ? undefined : next();
    // Telegram announces an upgrade in both chats; the new chat is still unknown when its announcement arrives.
    const title = ("title" in ctx.chat ? ctx.chat.title : null) ?? null;
    if (ctx.message?.migrate_to_chat_id) return followMigration(ctx.chat.id, ctx.message.migrate_to_chat_id, title);
    if (ctx.message?.migrate_from_chat_id) return followMigration(ctx.message.migrate_from_chat_id, ctx.chat.id, title);
    const record = await getChat(sql, ctx.chat.id);
    if (record?.status === "approved") return next();
    if (record?.status === "rejected") {
      await ctx.leaveChat().catch(() => {});
      return;
    }
    if (!record) {
      // Added before approvals existed or the join update was missed: queue it now.
      await registerChat(sql, ctx.chat.id, title, null);
      await askOwners(ctx.chat.id, title, undefined);
    }
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "Waiting for the bot owner's approval" }).catch(() => {});
  });

  bot.callbackQuery(/^(chatok|chatno|legacy):c(\d+)$/, async (ctx) => {
    const owner = await kit.identity(ctx.from);
    if (!kit.isOwner(owner)) return ctx.answerCallbackQuery({ text: "That's up to the bot owner" });
    const chatId = -Number(ctx.match[2]);
    const record = await getChat(sql, chatId);
    if (!record) return ctx.answerCallbackQuery({ text: "I don't know that chat" });
    const title = escapeHtml(record.title ?? String(chatId));
    if (ctx.match[1] === "chatok") {
      await ctx.answerCallbackQuery({ text: "Approved" });
      if (record.status !== "approved") await approve(chatId, owner.id);
      const offer = await legacyOffer(chatId);
      return kit.show(ctx, `✅ Chat <b>${title}</b> approved.${offer ? "\nThere's imported history — attach it to this chat?" : ""}`, offer, { edit: true });
    }
    if (ctx.match[1] === "chatno") {
      await ctx.answerCallbackQuery({ text: "Rejected" });
      await setChatStatus(sql, chatId, "rejected", owner.id);
      await bot.api.leaveChat(chatId).catch(() => {});
      return kit.show(ctx, `🚫 Chat <b>${title}</b> rejected, and I've left it.`, undefined, { edit: true });
    }
    if (record.status !== "approved") return ctx.answerCallbackQuery({ text: "Approve the chat first" });
    await ctx.answerCallbackQuery({ text: "Moving…" });
    const moved = await attachLegacyData(sql, chatId, owner.id);
    const notes = [
      moved.projectsMerged ? `${countOf(moved.projectsMerged, "imported project")} merged into projects the chat already had` : "",
      moved.cardsLinked ? `${countOf(moved.cardsLinked, "card")} linked to the members' accounts` : "",
    ].filter(Boolean);
    await kit.show(
      ctx,
      `📥 Import attached to <b>${title}</b>: ${countOf(moved.messages, "message")}, ${countOf(moved.members, "card")}, ${countOf(moved.projects, "project")}, ${countOf(moved.topics, "chronicle topic")}.${notes.length ? `\n${notes.join("; ")}.` : ""}`,
      undefined,
      { edit: true },
    );
  });

  bot.command("chats", async (ctx) => {
    if (!ctx.from || !kit.isPrivate(ctx)) return;
    const owner = await kit.identity(ctx.from);
    if (!kit.isOwner(owner)) return;
    const chats = await allChats(sql);
    if (chats.length === 0) return void (await kit.show(ctx, "I haven't been added anywhere yet. Add the bot to a group and I'll send you an approval request."));
    const labels: Record<string, string> = { pending: "⏳ pending", approved: "✅ active", rejected: "🚫 rejected", left: "👋 left" };
    for (const chat of chats) {
      const keyboard =
        chat.status === "pending"
          ? chatButtons(chat.id)
          : chat.status === "approved"
            ? await legacyOffer(chat.id)
            : chat.status === "rejected"
              ? new InlineKeyboard().text("✅ Approve after all", `chatok:${encodeChat(chat.id)}`)
              : undefined;
      await kit.show(ctx, `<b>${escapeHtml(chat.title ?? String(chat.id))}</b> · ${labels[chat.status]}\n<code>${chat.id}</code>`, keyboard);
    }
  });

  // ---------- Archiving: every group message is stored before commands run. It never calls the LLM ----------

  bot.on("chat_member", async (ctx) => {
    const member = ctx.chatMember.new_chat_member;
    membership.invalidate(ctx.chat.id, member.user.id);
    // A restricted (muted) member who leaves keeps status "restricted", with is_member false.
    if (!isInChat(member)) await markLeft(sql, ctx.chat.id, member.user.id);
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
      const anonymous = isAnonymousPost(message, ctx.from);
      const person = ctx.from && !ctx.from.is_bot && !anonymous ? ctx.from : undefined;
      if ((person || anonymous) && !message.new_chat_members && !message.left_chat_member && !isChatServiceNote(message)) {
        const isCommand = message.entities?.[0]?.type === "bot_command" && message.entities[0].offset === 0;
        const user = person ? await kit.identity(person, chatId) : undefined;
        if (!isCommand) {
          const replied = realReply(message);
          await saveMessage(sql, {
            chatId,
            msgId: message.message_id,
            userId: user?.id ?? null,
            sentAt: new Date(message.date * 1000),
            text: messageText(message),
            replyToMsgId: replied?.message_id ?? null,
            replyToBot: replied?.from?.id === ctx.me.id,
            isForward: Boolean(message.forward_origin || message.is_automatic_forward),
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

  // Any button ends what the bot was waiting to be typed: Cancel, Back, another screen alike. A prompt re-arms it after this.
  bot.on("callback_query", async (ctx, next) => {
    if (kit.isPrivate(ctx)) kit.pending.clear(ctx.from.id);
    return next();
  });

  const profile = registerProfile(kit);
  const catalog = registerCatalog(kit);

  // ---------- Switching chats in DM ----------

  const menu = (chatId: number) =>
    new InlineKeyboard().text("👤 My card", `me:${encodeChat(chatId)}:home`).text("🏆 Projects", "pl:top:0").row().text("📜 Chronicle", "ch:3:0").text("👥 Members", "pp:0");

  async function homeScreen(ctx: BotContext, scope: Scope, greeting: string, edit = false) {
    const chats = await chatsOfUser(sql, scope.user.id);
    const keyboard = menu(scope.chatId);
    const app = kit.appButton(ctx, scope.chatId, "📱 App", "/", "home");
    if (app) keyboard.row().add(app);
    if (chats.length > 1) keyboard.row().text("🔁 Other chat", "chat:pick");
    const chatTitle = chats.find((chat) => chat.id === scope.chatId)?.title;
    const where = chatTitle ? `\n💬 Current chat: <b>${escapeHtml(chatTitle)}</b>` : "";
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
    if (scope) await homeScreen(ctx, scope, "Done 👌", true);
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
    await homeScreen(ctx, scope, `Hi, ${escapeHtml(user.display_name)}! 👋`);
  });

  bot.command("help", (ctx) => kit.show(ctx, HELP_TEXT));

  bot.command("app", async (ctx) => {
    const scope = await kit.scope(ctx);
    if (!scope) return;
    const button = kit.appButton(ctx, scope.chatId, "📱 Open the app", "/", "home");
    if (!button) return void (await kit.show(ctx, "The web app isn't set up yet — everything is available through commands, see /help"));
    await kit.show(ctx, "People, projects and the chronicle — in the app:", new InlineKeyboard().add(button));
  });

  async function runCatchup(ctx: BotContext, scope: Scope, hours?: number) {
    const data = await catchupFor(sql, scope.chatId, scope.person, hours);
    const html = catchupHtml(data, await kit.usersById(), scope.chatId, config.EXTRACTION_INTERVAL_HOURS, config.DISPLAY_TIMEZONE);
    const keyboard = new InlineKeyboard().text("📜 Full chronicle", "ch:3:0");
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
    const openBot = new InlineKeyboard().url("Open the bot", `https://t.me/${bot.botInfo.username}?start=${encodeChat(scope.chatId)}_catchup`);
    if (!scope.user.dm_started) return void (await kit.show(ctx, "I'll send the summary to your DM — open the bot first 👇", openBot));
    await ctx.react("👌").catch(() => {});
    try {
      await runCatchup(ctx, scope, sinceHours);
    } catch (error) {
      if (error instanceof GrammyError && error.error_code === 403) {
        await sql`UPDATE users SET dm_started = false WHERE id = ${scope.user.id}`;
        return void (await kit.show(ctx, "I can't message you directly — open the bot 👇", openBot));
      }
      throw error;
    }
  });

  bot.command("link", async (ctx) => {
    if (!ctx.from || !isGroup(ctx)) return;
    const admin = await kit.identity(ctx.from, ctx.chat.id);
    if (!kit.isOwner(admin)) return;
    const target = realReply(ctx.msg)?.from;
    const seedName = commandArgs(ctx);
    if (!target || target.is_bot || SERVICE_TG_IDS.includes(target.id) || !seedName) {
      return void (await kit.show(ctx, "Reply to the person's message: /link Name from the seed cards"));
    }
    const into = await kit.identity(target, ctx.chat.id);
    const [seed] = await sql<User[]>`
      SELECT u.* FROM users u JOIN members m ON m.user_id = u.id
      WHERE u.tg_id IS NULL AND m.chat_id = ${ctx.chat.id} AND lower(u.display_name) = lower(${seedName})`;
    if (!seed) return void (await kit.show(ctx, `No unlinked card named “${escapeHtml(seedName)}”`));
    await mergeSeedUser(sql, seed.id, into.id, admin.id);
    await kit.show(ctx, `Linked the card “${escapeHtml(seed.display_name)}” to ${userHeader(into)} ✅`);
  });

  bot.command("botstatus", async (ctx) => {
    if (!ctx.from || !kit.isPrivate(ctx)) return;
    const user = await kit.identity(ctx.from);
    if (!kit.isOwner(user)) return;
    const lines = ["<b>Status</b>", `Chronicler: every ${config.EXTRACTION_INTERVAL_HOURS} h`];
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
      const [skipped] = await sql<{ messages: number }[]>`
        SELECT coalesce(sum((range->>'messages')::int), 0)::int AS messages
        FROM extraction_runs r, jsonb_array_elements(coalesce(r.stats->'skipped', '[]'::jsonb)) AS range
        WHERE r.chat_id = ${chat.id} AND r.started_at > now() - interval '30 days'`;
      const [passRetry, cleanupRetry] = await Promise.all([nextExtractionRetryAt(sql, chat.id), nextConsolidationRetryAt(sql, chat.id)]);
      const lastLine = last
        ? `${last.at ? formatDate(last.at, config.DISPLAY_TIMEZONE) : "running now"} · ${last.status} · ${countOf(last.messages_count, "message")}${last.error ? `\n⚠️ ${escapeHtml(last.error)}` : ""}`
        : "none yet";
      const later = (at: Date | null) => (at && at.getTime() > Date.now() ? formatDate(at, config.DISPLAY_TIMEZONE) : null);
      lines.push(
        "",
        ...[
          `💬 <b>${escapeHtml(chat.title ?? String(chat.id))}</b>`,
          `Messages: ${counts?.messages}, waiting for the chronicler: ${counts?.pending}. Last run — ${lastLine}`,
          later(passRetry) ? `The chronicler failed; next attempt ${later(passRetry)}` : "",
          later(cleanupRetry) ? `⚠️ The weekly card clean-up failed; next attempt ${later(cleanupRetry)}` : "",
          skipped?.messages ? `⚠️ Skipped in the last 30 days: ${countOf(skipped.messages, "message")} the chronicler could not process` : "",
          `Members: ${counts?.members}, facts: ${counts?.facts}, projects: ${counts?.projects}, topics: ${counts?.topics}`,
          counts?.unlinked?.length ? `Unlinked cards: ${counts.unlinked.map(escapeHtml).join(", ")} — reply with /link Name` : "All cards are linked",
          `AI this month: $${spent.toFixed(3)} of $${budget.toFixed(2)}`,
        ].filter(Boolean),
      );
    }
    lines.push("", `Total AI spend this month: $${(await monthSpendUsd(sql)).toFixed(3)} of $${config.MONTHLY_LLM_BUDGET_USD}`);
    const pending = (await allChats(sql)).filter((chat) => chat.status === "pending").length;
    if (pending) lines.push(`⏳ Chats awaiting approval: ${pending} — /chats`);
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
      if (scope) await kit.show(ctx, "Pick what to open, or see /help 👇", menu(scope.chatId));
      return;
    }
    const username = bot.botInfo.username;
    if (text.toLowerCase().includes(`@${username.toLowerCase()}`)) await kit.show(ctx, HELP_TEXT);
  });

  // Registered last: a button from an older version (or a removed feature) gets an answer instead of an endless spinner.
  bot.on("callback_query:data", (ctx) => ctx.answerCallbackQuery({ text: "This button is outdated — send the command again" }));

  bot.catch(async (error) => {
    const upgrade = upgradeOf(error.error, error.ctx.chat?.id);
    if (upgrade) {
      await followMigration(upgrade.from, upgrade.to, null).catch((migrationError) => console.error(`[bot] could not follow ${upgrade.from} → ${upgrade.to}:`, migrationError));
      return;
    }
    console.error(`[bot] update ${error.ctx.update.update_id} failed:`, error.error);
    if (error.ctx.callbackQuery) void error.ctx.answerCallbackQuery({ text: "Something went wrong 😕" }).catch(() => {});
  });

  return { bot, membership };
}

const OWNER_COMMANDS = [
  ...PRIVATE_COMMANDS,
  { command: "chats", description: "Bot's chats: approve, attach import" },
  { command: "botstatus", description: "Chronicler status and budget" },
];

/**
 * With `sql`, owners removed from ADMIN_TG_IDS also lose their owner menu, and the stored is_admin flag is
 * brought in line with the list (nothing trusts the flag; it is kept accurate for whoever reads the table).
 */
export async function registerCommands(bot: Bot<BotContext>, ownerTgIds: number[], sql?: Sql): Promise<void> {
  await bot.api.setMyCommands(GROUP_COMMANDS, { scope: { type: "all_group_chats" } });
  await bot.api.setMyCommands(PRIVATE_COMMANDS, { scope: { type: "all_private_chats" } });
  for (const tgId of ownerTgIds) {
    await bot.api.setMyCommands(OWNER_COMMANDS, { scope: { type: "chat", chat_id: tgId } }).catch(() => {});
  }
  if (!sql) return;
  const former = await sql<{ tg_id: number }[]>`
    SELECT tg_id FROM users WHERE is_admin AND tg_id IS NOT NULL AND NOT (tg_id = ANY(${ownerTgIds}::bigint[]))`;
  for (const { tg_id: tgId } of former) {
    await bot.api.deleteMyCommands({ scope: { type: "chat", chat_id: tgId } }).catch(() => {});
  }
  await sql`
    UPDATE users SET is_admin = coalesce(tg_id = ANY(${ownerTgIds}::bigint[]), false)
    WHERE is_admin IS DISTINCT FROM coalesce(tg_id = ANY(${ownerTgIds}::bigint[]), false)`;
}

/** Owners are the configured ADMIN_TG_IDS only; `sql` is unused and kept for existing callers. */
export async function notifyAdmins(bot: Bot<BotContext>, _sql: Sql, adminTgIds: number[], text: string): Promise<void> {
  for (const tgId of new Set(adminTgIds)) {
    await bot.api.sendMessage(tgId, text).catch(() => {});
  }
}

export const ALLOWED_UPDATES = ["message", "edited_message", "callback_query", "chat_member", "my_chat_member"] as const;
