import { InlineKeyboard } from "grammy";
import { memberAliases } from "../core/aliases.js";
import { waitingReminders } from "../core/member-reminders.js";
import { ownMemos } from "../core/memos.js";
import { chatsOfUser, getChat } from "../core/chats.js";
import {
  FACT_KIND_LABELS,
  getFact,
  ownFacts,
  proposeFact,
  rejectFact,
  setFactHidden,
  visibleFacts,
  type FactKind,
} from "../core/facts.js";
import { addUserProject, canEditProject, projectsOfUser, updateProject, type ProjectFields } from "../core/projects.js";
import { escapeHtml, extractUrls, isRepoHost, safeHttpUrl, truncate } from "../core/text.js";
import { forgetUser, getPerson, setOptOut, setTagline } from "../core/users.js";
import { ownWishes } from "../core/wishes.js";
import { localTimeOf, memberClock, zoneLabel, type MemberClock } from "../core/zones.js";
import { countOf, factsWithSources, personCard, userHeader } from "./format.js";
import {
  decodeChat,
  encodeChat,
  grid,
  type BotContext,
  type BotKit,
  type PendingInput,
  type Scope,
} from "./kit.js";
import { dueLabel } from "./reminders.js";

const MANUAL_KINDS: FactKind[] = [
  "role",
  "stack",
  "expertise",
  "interest",
  "looking_for",
  "can_help",
  "link",
  "timezone",
];

const KIND_PROMPTS: Record<FactKind, string> = {
  role: "What do you do? For example: “backend developer”, “3D artist in gamedev”",
  stack:
    "What do you use? Several, comma-separated, is fine: “Rust, Tauri, Claude Code”",
  expertise:
    "What can people ask you about? For example: “self-hosted VPN”, “Unity shaders”",
  interest: "What are you into? For example: “skydiving”, “retro consoles”",
  looking_for:
    "What are you looking for? For example: “beta testers”, “a designer co-founder”",
  can_help:
    "How can you help others? For example: “architecture reviews”, “server setup”",
  link: "Send a link: GitHub, website, portfolio, channel",
  timezone: "Where are you / what's your time zone? For example: “Berlin”, “UTC+3”",
  project: "Describe the project in a few words",
};

/** How much of each reminder or thing to do later «What do you know about me» shows: twenty of them still fit one message. */
const REMINDER_SHOWN_CHARS = 120;

/** Buttons are made for one chat and carry it («me:c100123:privacy»), so a tap acts there whatever chat is current. */
const meButton = (chatId: number, action: string) => `me:${encodeChat(chatId)}:${action}`;
const cancelKeyboard = (chatId: number) => new InlineKeyboard().text("Cancel", meButton(chatId, "cancel"));

export interface ProfileHandlers {
  handleInput: (
    ctx: BotContext,
    input: PendingInput,
    text: string,
  ) => Promise<void>;
  profileScreen: (
    ctx: BotContext,
    scope: Scope,
    edit?: boolean,
  ) => Promise<void>;
}

const CLOCK_FROM: Record<MemberClock["source"], string> = {
  chat: "you set it in the chat",
  app: "you set it in the Mini App",
  device: "taken from your device",
  card: "from the place on your card",
  chat_zone: "the chat's: you haven't set one",
};

/** «🕐 Time zone: Asia/Shanghai, 06:30 now (from the place on your card: «Китай»)». */
function clockLine(clock: MemberClock): string {
  const place = clock.place ? `«${escapeHtml(clock.place)}»` : "";
  const from = clock.unclear ? `${place} spans ${clock.unclear} time zones: tell me your city in the chat or pick one in /app` : clock.source === "card" ? `${CLOCK_FROM.card}: ${place}` : CLOCK_FROM[clock.source];
  return `🕐 Time zone: ${escapeHtml(zoneLabel(clock.zone))}, ${localTimeOf(new Date(), clock.zone)} now (${from})`;
}

export function registerProfile(kit: BotKit): ProfileHandlers {
  const { bot, sql, pending } = kit;
  const retention = countOf(kit.config.MESSAGE_RETENTION_DAYS, "day");

  /** Re-reads the person so screens show what was just saved. */
  const refreshed = async (scope: Scope): Promise<Scope> => ({
    ...scope,
    person: (await getPerson(sql, scope.chatId, scope.user.id)) ?? scope.person,
  });

  const chatTitle = async (chatId: number) =>
    escapeHtml((await getChat(sql, chatId))?.title ?? "this chat");

  async function profileScreen(ctx: BotContext, scope: Scope, edit = false) {
    const { person, chatId, user } = scope;
    const [facts, projects, hidden, chats, aliases] = await Promise.all([
      visibleFacts(sql, chatId, user.id),
      projectsOfUser(sql, chatId, user.id),
      sql<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM facts WHERE chat_id = ${chatId} AND user_id = ${user.id} AND status = 'hidden'`,
      chatsOfUser(sql, user.id),
      memberAliases(sql, chatId, user.id),
    ]);
    const hiddenCount = hidden[0]?.count ?? 0;
    const chatName = chats.find((chat) => chat.id === chatId)?.title;
    const text = [
      personCard(person, facts, projects, { aliases }),
      "",
      person.opted_out
        ? "🚫 Data collection about you is off in this chat."
        : "Chat members can see this card. The chronicler fills it in as you chat, and you can fix anything.",
      chats.length > 1 && chatName
        ? `\n💬 Chat: <b>${escapeHtml(chatName)}</b>`
        : "",
    ]
      .join("\n")
      .trim();
    const keyboard = new InlineKeyboard();
    if (!person.opted_out) {
      keyboard
        .text("✏️ One-liner", meButton(chatId, "tagline"))
        .text("➕ Add", meButton(chatId, "add"))
        .row();
      if (facts.length)
        keyboard
          .text("❌ Remove wrong", meButton(chatId, "wrong"))
          .text("🙈 Hide", meButton(chatId, "hide"))
          .row();
      if (hiddenCount) keyboard.text(`👁 Hidden (${hiddenCount})`, meButton(chatId, "hidden"));
    }
    keyboard.text("🛠 My projects", meButton(chatId, "projects")).row();
    keyboard.text("🔒 Privacy", meButton(chatId, "privacy"));
    const app = kit.appButton(ctx, chatId, "📱 In the app", "/me", "me");
    if (app) keyboard.add(app);
    if (chats.length > 1) keyboard.row().text("🔁 Other chat", "chat:pick");
    await kit.show(ctx, text, keyboard, { edit });
  }

  async function factListScreen(
    ctx: BotContext,
    scope: Scope,
    mode: "wrong" | "hide" | "hidden",
  ) {
    const facts =
      mode === "hidden"
        ? (await ownFacts(sql, scope.chatId, scope.user.id)).filter(
            (fact) => fact.status === "hidden",
          )
        : await visibleFacts(sql, scope.chatId, scope.user.id);
    const title = {
      wrong:
        "❌ <b>What's wrong?</b> Tap a number — the fact disappears and the chronicler won't add it again.",
      hide: "🙈 <b>What should be hidden?</b> Others can't see hidden facts, and you can bring them back.",
      hidden: "👁 <b>Hidden facts.</b> Tap a number to put it back on your card.",
    }[mode];
    const action = { wrong: "rej", hide: "hide", hidden: "unhide" }[mode];
    const icon = { wrong: "❌", hide: "🙈", hidden: "↩️" }[mode];
    const buttons = facts
      .slice(0, 40)
      .map((fact, index) =>
        InlineKeyboard.text(`${icon} ${index + 1}`, `${action}:${fact.id}`),
      );
    const keyboard = grid(buttons, 5).row().text("← Back", meButton(scope.chatId, "home"));
    await kit.show(
      ctx,
      `${title}\n\n${factsWithSources(facts, scope.chatId)}`,
      keyboard,
      { edit: true },
    );
  }

  async function privacyScreen(ctx: BotContext, scope: Scope) {
    const chat = await chatTitle(scope.chatId);
    const text = scope.person.opted_out
      ? `🚫 <b>Collection is off in ${chat}.</b> The chronicler records nothing about you there, and there's no card. Your messages stay in the chat's shared archive; their texts are deleted after ${retention}, once the chronicler has gone through them.`
      : [
          `🔒 <b>Privacy</b> · ${chat}`,
          "Every few hours the chronicler goes through new messages and updates the cards. It never records politics, health, finances, personal life, addresses or secrets.",
          "Any fact can be removed with the “❌ Remove wrong” button.",
        ].join("\n\n");
    const keyboard = new InlineKeyboard()
      .text("📋 What do you know about me", meButton(scope.chatId, "know"))
      .row();
    if (scope.person.opted_out)
      keyboard.text("✅ Keep my card again", `priv:${encodeChat(scope.chatId)}:on`);
    else keyboard.text("🚫 Stop collecting about me", `priv:${encodeChat(scope.chatId)}:off`);
    keyboard.row().text("← Back", meButton(scope.chatId, "home"));
    await kit.show(ctx, text, keyboard, { edit: true });
  }

  async function knowledgeScreen(ctx: BotContext, scope: Scope, edit: boolean) {
    const { person, chatId, user } = scope;
    const [facts, memos, reminders, clock, wishes] = await Promise.all([
      ownFacts(sql, chatId, user.id),
      ownMemos(sql, chatId, user.id),
      waitingReminders(sql, chatId, user.id),
      memberClock(sql, chatId, user.id, kit.config.DISPLAY_TIMEZONE),
      ownWishes(sql, chatId, user.id),
    ]);
    const [stats] = await sql<{ messages: number; first: Date | null }[]>`
      SELECT count(*)::int AS messages, min(sent_at) AS first FROM messages WHERE chat_id = ${chatId} AND user_id = ${user.id}`;
    const text = [
      userHeader(user),
      person.tagline
        ? `One-liner: ${escapeHtml(person.tagline)}${person.tagline_manual ? " ✍️" : ""}`
        : "No one-liner",
      clockLine(clock),
      `Messages in the archive of ${await chatTitle(chatId)}: ${stats?.messages ?? 0}${stats?.first ? ` (since ${stats.first.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: clock.zone })})` : ""}`,
      "",
      "<b>Facts</b> (✍️ — added by you, 🙈 — hidden, numbers — source messages):",
      factsWithSources(facts, chatId),
      ...(memos.length
        ? ["", "<b>Your notes</b>:", ...memos.map((memo) => `📝 ${escapeHtml(memo.text)}${memo.project_name ? ` <i>— on ${escapeHtml(memo.project_name)}</i>` : ""}`)]
        : []),
      ...(reminders.length
        ? [
            "",
            "<b>Your reminders and things to do later</b> (✖️ under a receipt cancels one):",
            ...reminders.map((reminder) => `${reminder.kind === "action" ? "⏳" : "⏰"} ${escapeHtml(dueLabel(reminder.due_at, clock.zone, "English"))}: ${escapeHtml(truncate(reminder.text, REMINDER_SHOWN_CHARS))}`),
          ]
        : []),
      ...(wishes.length
        ? [
            "",
            "<b>Your wishes</b>, what you asked me not to write, or not in some way (↩️ under my receipt, or asking in the chat, takes one back):",
            ...wishes.map((wish) => `🤐 ${escapeHtml(truncate(wish.text, REMINDER_SHOWN_CHARS))}${wish.scope === "chat" ? " <i>— for the whole chat</i>" : ""}`),
          ]
        : []),
      "",
      `Message texts are kept for ${retention} for the chronicle and /catchup, then deleted once the chronicler has gone through them. To delete everything about you in all chats — /forgetme.`,
    ].join("\n");
    await kit.show(
      ctx,
      text,
      edit ? new InlineKeyboard().text("← Back", meButton(chatId, "privacy")) : undefined,
      { edit },
    );
  }

  async function myProjectsScreen(ctx: BotContext, scope: Scope) {
    const projects = await projectsOfUser(sql, scope.chatId, scope.user.id);
    const buttons = projects.map((project) =>
      InlineKeyboard.text(project.name, `p:${project.slug}`),
    );
    const keyboard = grid(buttons, 2)
      .row()
      .text("➕ New project", `np:${encodeChat(scope.chatId)}:start`)
      .row()
      .text("← Back", meButton(scope.chatId, "home"));
    const text = projects.length
      ? "🛠 <b>Your projects</b>\nTap a project to edit its status, description, stack or links."
      : "🛠 You have no projects in the catalog yet. Add one — others will hear about it, and it gets into the rating.";
    await kit.show(ctx, text, keyboard, { edit: true });
  }

  const dmOnly = (ctx: BotContext) => {
    if (kit.isPrivate(ctx)) return true;
    void ctx.answerCallbackQuery({ text: "This works in a DM with the bot" }).catch(() => undefined);
    return false;
  };

  bot.callbackQuery(
    /^me:c(\d+):(home|tagline|tagline_reset|add|wrong|hide|hidden|privacy|know|projects|cancel)$/,
    async (ctx) => {
      if (!dmOnly(ctx)) return;
      await ctx.answerCallbackQuery();
      const scope = await kit.scopeForChat(ctx, decodeChat(ctx.match[1]));
      if (!scope) return;
      const chatId = scope.chatId;
      switch (ctx.match[2]) {
        case "home":
        case "cancel":
          return profileScreen(ctx, scope, true);
        case "tagline":
          pending.set(ctx.from.id, { kind: "tagline", chatId });
          return kit.show(
            ctx,
            `✏️ Write a one-liner about who you are — up to 90 characters.\nNow: ${scope.person.tagline ? `<i>${escapeHtml(scope.person.tagline)}</i>` : "none"}`,
            new InlineKeyboard()
              .text("Reset", meButton(chatId, "tagline_reset"))
              .text("Cancel", meButton(chatId, "cancel")),
            { edit: true },
          );
        case "tagline_reset":
          await setTagline(sql, chatId, scope.user.id, null, scope.user.id);
          return profileScreen(ctx, await refreshed(scope), true);
        case "add":
          return kit.show(
            ctx,
            "➕ <b>What should I add?</b>",
            grid(
              MANUAL_KINDS.map((kind) =>
                InlineKeyboard.text(FACT_KIND_LABELS[kind], `addk:${encodeChat(chatId)}:${kind}`),
              ),
              2,
            )
              .row()
              .text("← Back", meButton(chatId, "home")),
            { edit: true },
          );
        case "wrong":
        case "hide":
        case "hidden":
          return factListScreen(ctx, scope, ctx.match[2]);
        case "privacy":
          return privacyScreen(ctx, scope);
        case "know":
          return knowledgeScreen(ctx, scope, true);
        case "projects":
          return myProjectsScreen(ctx, scope);
      }
    },
  );

  // Buttons from before chats were named in them: which chat they meant is unknown, so they do nothing.
  bot.callbackQuery(
    /^(?:me:[a-z_]+|addk:\w+|priv:(?:on|off)|forget:here:(?:facts|messages)|np:start)$/,
    (ctx) => ctx.answerCallbackQuery({ text: "This button is outdated — open /me again" }),
  );

  bot.callbackQuery(/^addk:c(\d+):(\w+)$/, async (ctx) => {
    const kind = ctx.match[2] as FactKind;
    if (!dmOnly(ctx) || !MANUAL_KINDS.includes(kind))
      return ctx.answerCallbackQuery().catch(() => undefined);
    await ctx.answerCallbackQuery();
    const scope = await kit.scopeForChat(ctx, decodeChat(ctx.match[1]));
    if (!scope) return;
    pending.set(ctx.from.id, {
      kind: "fact",
      chatId: scope.chatId,
      factKind: kind,
    });
    await kit.show(
      ctx,
      `<b>${FACT_KIND_LABELS[kind]}</b>\n${escapeHtml(KIND_PROMPTS[kind])}`,
      cancelKeyboard(scope.chatId),
      { edit: true },
    );
  });

  bot.callbackQuery(/^(rej|hide|unhide):(\d+)$/, async (ctx) => {
    const user = await kit.identity(ctx.from);
    const fact = await getFact(sql, Number(ctx.match[2]));
    const isOwn = fact?.user_id === user.id;
    if (!fact || (!isOwn && !kit.isOwner(user)))
      return ctx.answerCallbackQuery({ text: "That's not your fact" });
    const source = isOwn ? "user" : "admin";
    const action = ctx.match[1];
    if (action === "rej") await rejectFact(sql, fact.id, user.id, source);
    else await setFactHidden(sql, fact.id, action === "hide", user.id, source);
    await ctx.answerCallbackQuery({
      text:
        action === "rej"
          ? "Removed for good 👌"
          : action === "hide"
            ? "Hidden 🙈"
            : "Back on your card 👁",
    });
    if (!isOwn || !kit.isPrivate(ctx)) return;
    const person = await getPerson(sql, fact.chat_id, user.id);
    if (person)
      await factListScreen(
        ctx,
        { user, chatId: fact.chat_id, person },
        action === "rej" ? "wrong" : action === "hide" ? "hide" : "hidden",
      );
  });

  bot.callbackQuery(/^priv:c(\d+):(on|off)$/, async (ctx) => {
    if (!dmOnly(ctx)) return;
    await ctx.answerCallbackQuery();
    const chatId = decodeChat(ctx.match[1]);
    if (ctx.match[2] === "on") {
      const scope = await kit.scopeForChat(ctx, chatId);
      if (!scope) return;
      await setOptOut(sql, scope.user.id, false, chatId);
      return privacyScreen(ctx, await refreshed(scope));
    }
    // Removing what the bot knows about you is never refused, even in a chat you have left since.
    const user = await kit.identity(ctx.from);
    if (!(await getPerson(sql, chatId, user.id))) return;
    await kit.show(ctx, forgetPrompt(await chatTitle(chatId)), forgetKeyboard(encodeChat(chatId)), { edit: true });
  });

  const forgetPrompt = (chat: string | null) =>
    chat
      ? `Delete all facts about you in <b>${chat}</b> and stop collecting anything there? You can also delete the text of your messages from that chat's archive.`
      : "Delete all facts about you in all chats and stop collecting anything? You can also delete the text of your messages from the archives.";
  const forgetKeyboard = (where: string) =>
    new InlineKeyboard()
      .text("Yes, delete facts", `forget:${where}:facts`)
      .row()
      .text("Delete message texts too", `forget:${where}:messages`)
      .row()
      .text("Cancel", "forget:no");

  bot.command("forgetme", async (ctx) => {
    if (!kit.isPrivate(ctx))
      return kit.show(ctx, "That one's for DMs: send me /forgetme");
    await kit.show(ctx, forgetPrompt(null), forgetKeyboard("all"));
  });

  bot.callbackQuery(
    /^forget:(?:(all|c\d+):(facts|messages)|no)$/,
    async (ctx) => {
      await ctx.answerCallbackQuery();
      const [, where, what] = ctx.match;
      if (!where) return kit.show(ctx, "Okay, leaving everything as is 🙂", undefined, { edit: true });
      const user = await kit.identity(ctx.from);
      const chatId = where === "all" ? undefined : decodeChat(where.slice(1));
      if (chatId !== undefined && !(await getPerson(sql, chatId, user.id))) return;
      await forgetUser(sql, user.id, { chatId, messages: what === "messages" });
      const scopeText = chatId !== undefined ? ` in <b>${await chatTitle(chatId)}</b>` : "";
      await kit.show(
        ctx,
        what === "messages"
          ? `Deleted the facts and the text of your messages${scopeText}. I'm no longer collecting anything about you${chatId !== undefined ? " there" : ""}. Changed your mind? /me → 🔒 Privacy.`
          : `Deleted all facts${scopeText}. I'm no longer collecting anything about you${chatId !== undefined ? " there" : ""}. Changed your mind? /me → 🔒 Privacy.`,
        undefined,
        { edit: true },
      );
    },
  );

  bot.command("whatyouknow", async (ctx) => {
    if (!ctx.from) return;
    if (!kit.isPrivate(ctx))
      return kit.show(ctx, "That one's for DMs: send me /whatyouknow 🙂");
    const scope = await kit.scope(ctx);
    if (scope) await knowledgeScreen(ctx, scope, false);
  });

  bot.command("me", async (ctx) => {
    if (!ctx.from) return;
    const scope = await kit.scope(ctx);
    if (!scope) return;
    if (kit.isPrivate(ctx)) return profileScreen(ctx, scope);
    const [facts, projects, aliases] = await Promise.all([
      visibleFacts(sql, scope.chatId, scope.user.id),
      projectsOfUser(sql, scope.chatId, scope.user.id),
      memberAliases(sql, scope.chatId, scope.user.id),
    ]);
    await kit.show(
      ctx,
      personCard(scope.person, facts, projects, { compact: true, aliases }),
      new InlineKeyboard().url(
        "✏️ Edit in DM",
        `https://t.me/${bot.botInfo.username}?start=${encodeChat(scope.chatId)}_me`,
      ),
    );
  });

  bot.callbackQuery(/^np:c(\d+):start$/, async (ctx) => {
    if (!kit.isPrivate(ctx))
      return ctx.answerCallbackQuery({
        text: "You can add a project in a DM with the bot",
      });
    await ctx.answerCallbackQuery();
    const scope = await kit.scopeForChat(ctx, decodeChat(ctx.match[1]));
    if (!scope) return;
    pending.set(ctx.from.id, {
      kind: "new_project_name",
      chatId: scope.chatId,
    });
    await kit.show(
      ctx,
      "🛠 <b>New project.</b> What's it called?",
      cancelKeyboard(scope.chatId),
      { edit: true },
    );
  });

  bot.callbackQuery(/^np:skip:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!kit.isPrivate(ctx)) return;
    // Only the project's own author, still in its chat, gets an answer: the id in the button can be anything.
    const [project] = await sql<{ slug: string; chat_id: number }[]>`
      SELECT p.slug, p.chat_id FROM projects p
      WHERE p.id = ${Number(ctx.match[1])} AND NOT p.hidden
        AND EXISTS (SELECT 1 FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = p.id AND u.tg_id = ${ctx.from.id})`;
    if (!project || !(await kit.scopeForChat(ctx, project.chat_id))) return;
    await kit.show(
      ctx,
      `Done ✅ Open the project to add a description and stack: /project ${escapeHtml(project.slug)}`,
      new InlineKeyboard().text("Open project", `p:${project.slug}`),
      { edit: true },
    );
  });

  const authorsOf = async (projectId: number) =>
    (
      await sql<{ display_name: string }[]>`
        SELECT u.display_name FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ${projectId} ORDER BY u.display_name`
    )
      .map((row) => escapeHtml(row.display_name))
      .join(", ");

  async function handleInput(
    ctx: BotContext,
    input: PendingInput,
    rawText: string,
  ) {
    const scope = await kit.scopeForChat(ctx, input.chatId);
    if (!scope) return;
    const { user } = scope;
    const text = rawText.trim();
    switch (input.kind) {
      case "tagline": {
        await setTagline(
          sql,
          scope.chatId,
          user.id,
          text.slice(0, 90),
          user.id,
        );
        await ctx.reply("One-liner updated ✅");
        return profileScreen(ctx, await refreshed(scope));
      }
      case "fact": {
        const kind = input.factKind as FactKind;
        const values =
          kind === "stack" || kind === "interest" || kind === "expertise"
            ? text.split(/[,;\n]+/)
            : [text];
        let added = 0;
        for (const value of values
          .map((part) => part.trim())
          .filter(Boolean)
          .slice(0, 10)) {
          const result = await proposeFact(sql, {
            chatId: scope.chatId,
            userId: user.id,
            kind,
            value,
            confidence: 1,
            sourceMsgIds: [],
            source: "user",
            actorUserId: user.id,
          });
          if (result === "added" || result === "reinforced") added += 1;
        }
        await ctx.reply(
          added
            ? `Added ✅ (${added})`
            : "Nothing added — maybe it's already on your card?",
        );
        return profileScreen(ctx, scope);
      }
      case "new_project_name": {
        const name = text.slice(0, 80);
        const result = await addUserProject(sql, { chatId: scope.chatId, name, actorUserId: user.id });
        if (result.outcome === "exists") {
          const authors = await authorsOf(result.project.id);
          await kit.show(
            ctx,
            `There's already <b>${escapeHtml(result.project.name)}</b> in this chat's catalog${authors ? ` (by ${authors})` : ""}. If yours is a different project, give it a name of its own.`,
            new InlineKeyboard()
              .text("Open it", `p:${result.project.slug}`)
              .text("Another name", `np:${encodeChat(scope.chatId)}:start`),
          );
          return;
        }
        pending.set(ctx.from!.id, {
          kind: "new_project_link",
          chatId: scope.chatId,
          projectId: result.project.id,
        });
        const project = `<b>${escapeHtml(result.project.name)}</b>`;
        const intro =
          result.outcome === "created"
            ? `Project ${project} added ✅`
            : result.outcome === "restored"
              ? `Project ${project} is back in the catalog ✅`
              : `${project} is already among your projects.`;
        await kit.show(
          ctx,
          `${intro}\nSend a link — repository or website:`,
          new InlineKeyboard().text("Skip", `np:skip:${result.project.id}`),
        );
        return;
      }
      case "new_project_link":
      case "project_field": {
        const projectId = input.projectId;
        const field = input.kind === "new_project_link" ? "links" : input.field;
        const [current] = await sql<
          { slug: string; is_author: boolean }[]
        >`SELECT p.slug, EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = ${user.id}) AS is_author
          FROM projects p WHERE p.id = ${projectId} AND p.chat_id = ${scope.chatId} AND NOT p.hidden`;
        if (!current || !(await canEditProject(sql, projectId, user.id, kit.isOwner(user))))
          return void (await ctx.reply("You can't edit that project anymore 🤔"));
        let fields: ProjectFields;
        if (field === "tagline") {
          fields = { tagline: text.slice(0, 200) };
        } else if (field === "stack") {
          fields = {
            stack: text
              .split(/[,;\n]+/)
              .map((part) => part.trim().slice(0, 40))
              .filter(Boolean)
              .slice(0, 20),
          };
        } else {
          const urls = extractUrls(text)
            .map(safeHttpUrl)
            .filter((url): url is string => url !== null);
          if (urls.length === 0) {
            pending.set(ctx.from!.id, input);
            await ctx.reply(
              "I don't see a link. Send something like https://github.com/you/project",
              { reply_markup: cancelKeyboard(scope.chatId) },
            );
            return;
          }
          const repo = urls.find((url) => isRepoHost(new URL(url).hostname));
          const site = urls.find((url) => url !== repo);
          fields = { links: { repo, site } };
        }
        const result = await updateProject(sql, {
          chatId: scope.chatId,
          projectId,
          ...fields,
          source: current.is_author ? "user" : "admin",
          actorUserId: user.id,
        });
        if (!result) return void (await ctx.reply("That project is gone from the catalog 🤔"));
        await ctx.reply(result.changed ? "Saved ✅" : "Nothing to change — it already says that.", {
          reply_markup: new InlineKeyboard().text(
            "Open project",
            `p:${current.slug}`,
          ),
        });
        return;
      }
    }
  }

  return { handleInput, profileScreen };
}
