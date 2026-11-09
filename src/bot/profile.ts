import { InlineKeyboard } from "grammy";
import { chatsOfUser } from "../core/chats.js";
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
import { projectsOfUser, upsertProject } from "../core/projects.js";
import { escapeHtml } from "../core/text.js";
import { getPerson, setOptOut, setTagline } from "../core/users.js";
import { factsWithSources, personCard, userHeader } from "./format.js";
import {
  encodeChat,
  grid,
  type BotContext,
  type BotKit,
  type PendingInput,
  type Scope,
} from "./kit.js";

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

const cancelKeyboard = () => new InlineKeyboard().text("Cancel", "me:cancel");

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

export function registerProfile(kit: BotKit): ProfileHandlers {
  const { bot, sql, pending } = kit;

  /** Re-reads the person so screens show what was just saved. */
  const refreshed = async (scope: Scope): Promise<Scope> => ({
    ...scope,
    person: (await getPerson(sql, scope.chatId, scope.user.id)) ?? scope.person,
  });

  async function profileScreen(ctx: BotContext, scope: Scope, edit = false) {
    const { person, chatId, user } = scope;
    const [facts, projects, hidden, chats] = await Promise.all([
      visibleFacts(sql, chatId, user.id),
      projectsOfUser(sql, chatId, user.id),
      sql<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM facts WHERE chat_id = ${chatId} AND user_id = ${user.id} AND status = 'hidden'`,
      chatsOfUser(sql, user.id),
    ]);
    const hiddenCount = hidden[0]?.count ?? 0;
    const chatTitle = chats.find((chat) => chat.id === chatId)?.title;
    const text = [
      personCard(person, facts, projects),
      "",
      person.opted_out
        ? "🚫 Data collection about you is off in this chat."
        : "Chat members can see this card. The chronicler fills it in as you chat, and you can fix anything.",
      chats.length > 1 && chatTitle
        ? `\n💬 Chat: <b>${escapeHtml(chatTitle)}</b>`
        : "",
    ]
      .join("\n")
      .trim();
    const keyboard = new InlineKeyboard();
    if (!person.opted_out) {
      keyboard
        .text("✏️ One-liner", "me:tagline")
        .text("➕ Add", "me:add")
        .row();
      if (facts.length)
        keyboard
          .text("❌ Remove wrong", "me:wrong")
          .text("🙈 Hide", "me:hide")
          .row();
      if (hiddenCount) keyboard.text(`👁 Hidden (${hiddenCount})`, "me:hidden");
    }
    keyboard.text("🛠 My projects", "me:projects").row();
    keyboard.text("🔒 Privacy", "me:privacy");
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
    const keyboard = grid(buttons, 5).row().text("← Back", "me:home");
    await kit.show(
      ctx,
      `${title}\n\n${factsWithSources(facts, scope.chatId)}`,
      keyboard,
      { edit: true },
    );
  }

  async function privacyScreen(ctx: BotContext, scope: Scope) {
    const text = scope.person.opted_out
      ? "🚫 <b>Collection is off.</b> The chronicler records nothing about you in this chat, and there's no card. Your messages stay in the chat's shared archive."
      : [
          "🔒 <b>Privacy</b>",
          "Every few hours the chronicler goes through new messages and updates the cards. It never records politics, health, finances, personal life, addresses or secrets.",
          "Any fact can be removed with the “❌ Remove wrong” button.",
        ].join("\n\n");
    const keyboard = new InlineKeyboard()
      .text("📋 What do you know about me", "me:know")
      .row();
    if (scope.person.opted_out)
      keyboard.text("✅ Keep my card again", "priv:on");
    else keyboard.text("🚫 Stop collecting about me", "priv:off");
    keyboard.row().text("← Back", "me:home");
    await kit.show(ctx, text, keyboard, { edit: true });
  }

  async function knowledgeScreen(ctx: BotContext, scope: Scope, edit: boolean) {
    const { person, chatId, user } = scope;
    const facts = await ownFacts(sql, chatId, user.id);
    const [stats] = await sql<{ messages: number; first: Date | null }[]>`
      SELECT count(*)::int AS messages, min(sent_at) AS first FROM messages WHERE chat_id = ${chatId} AND user_id = ${user.id}`;
    const text = [
      userHeader(user),
      person.tagline
        ? `One-liner: ${escapeHtml(person.tagline)}${person.tagline_manual ? " ✍️" : ""}`
        : "No one-liner",
      `Messages in this chat's archive: ${stats?.messages ?? 0}${stats?.first ? ` (since ${stats.first.toLocaleDateString("en-GB")})` : ""}`,
      "",
      "<b>Facts</b> (✍️ — added by you, 🙈 — hidden, numbers — source messages):",
      factsWithSources(facts, chatId),
      "",
      "Messages are kept for the chronicle and /catchup. To delete everything about you in all chats — /forgetme.",
    ].join("\n");
    await kit.show(
      ctx,
      text,
      edit ? new InlineKeyboard().text("← Back", "me:privacy") : undefined,
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
      .text("➕ New project", "np:start")
      .row()
      .text("← Back", "me:home");
    const text = projects.length
      ? "🛠 <b>Your projects</b>\nTap a project to edit its status, description, stack or links."
      : "🛠 You have no projects in the catalog yet. Add one — others will hear about it, and it gets into the rating.";
    await kit.show(ctx, text, keyboard, { edit: true });
  }

  /** Editing happens in DM only, for the chat currently picked there. */
  const dmScope = async (ctx: BotContext) =>
    ctx.from && kit.isPrivate(ctx) ? kit.scope(ctx) : undefined;

  bot.callbackQuery(
    /^me:(home|tagline|tagline_reset|add|wrong|hide|hidden|privacy|know|projects|cancel)$/,
    async (ctx) => {
      if (!kit.isPrivate(ctx))
        return ctx.answerCallbackQuery({
          text: "This works in a DM with the bot",
        });
      await ctx.answerCallbackQuery();
      const scope = await dmScope(ctx);
      if (!scope) return;
      switch (ctx.match[1]) {
        case "home":
        case "cancel":
          pending.clear(ctx.from.id);
          return profileScreen(ctx, scope, true);
        case "tagline":
          pending.set(ctx.from.id, { kind: "tagline", chatId: scope.chatId });
          return kit.show(
            ctx,
            `✏️ Write a one-liner about who you are — up to 90 characters.\nNow: ${scope.person.tagline ? `<i>${escapeHtml(scope.person.tagline)}</i>` : "none"}`,
            new InlineKeyboard()
              .text("Reset", "me:tagline_reset")
              .text("Cancel", "me:cancel"),
            { edit: true },
          );
        case "tagline_reset":
          pending.clear(ctx.from.id);
          await setTagline(
            sql,
            scope.chatId,
            scope.user.id,
            null,
            scope.user.id,
          );
          return profileScreen(ctx, await refreshed(scope), true);
        case "add":
          return kit.show(
            ctx,
            "➕ <b>What should I add?</b>",
            grid(
              MANUAL_KINDS.map((kind) =>
                InlineKeyboard.text(FACT_KIND_LABELS[kind], `addk:${kind}`),
              ),
              2,
            )
              .row()
              .text("← Back", "me:home"),
            { edit: true },
          );
        case "wrong":
        case "hide":
        case "hidden":
          return factListScreen(ctx, scope, ctx.match[1]);
        case "privacy":
          return privacyScreen(ctx, scope);
        case "know":
          return knowledgeScreen(ctx, scope, true);
        case "projects":
          return myProjectsScreen(ctx, scope);
      }
    },
  );

  bot.callbackQuery(/^addk:(\w+)$/, async (ctx) => {
    const kind = ctx.match[1] as FactKind;
    if (!kit.isPrivate(ctx) || !MANUAL_KINDS.includes(kind))
      return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    const scope = await dmScope(ctx);
    if (!scope) return;
    pending.set(ctx.from.id, {
      kind: "fact",
      chatId: scope.chatId,
      factKind: kind,
    });
    await kit.show(
      ctx,
      `<b>${FACT_KIND_LABELS[kind]}</b>\n${escapeHtml(KIND_PROMPTS[kind])}`,
      cancelKeyboard(),
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

  bot.callbackQuery(/^priv:(on|off)$/, async (ctx) => {
    if (!kit.isPrivate(ctx)) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    const scope = await dmScope(ctx);
    if (!scope) return;
    if (ctx.match[1] === "on") {
      await setOptOut(sql, scope.user.id, false, scope.chatId);
      return privacyScreen(ctx, await refreshed(scope));
    }
    await kit.show(ctx, forgetPrompt("here"), forgetKeyboard("here"), {
      edit: true,
    });
  });

  const forgetPrompt = (where: "here" | "all") =>
    where === "here"
      ? "Delete all facts about you in this chat and stop collecting anything here? You can also delete the text of your messages from this chat's archive."
      : "Delete all facts about you in all chats and stop collecting anything? You can also delete the text of your messages from the archives.";
  const forgetKeyboard = (where: "here" | "all") =>
    new InlineKeyboard()
      .text("Yes, delete facts", `forget:${where}:facts`)
      .row()
      .text("Delete message texts too", `forget:${where}:messages`)
      .row()
      .text("Cancel", "forget:no");

  bot.command("forgetme", async (ctx) => {
    if (!kit.isPrivate(ctx))
      return kit.show(ctx, "That one's for DMs: send me /forgetme");
    await kit.show(ctx, forgetPrompt("all"), forgetKeyboard("all"));
  });

  bot.callbackQuery(
    /^forget:(?:(here|all):(facts|messages)|no)$/,
    async (ctx) => {
      await ctx.answerCallbackQuery();
      const [, where, what] = ctx.match;
      if (!where) return ctx.editMessageText("Okay, leaving everything as is 🙂");
      let chatId: number | undefined;
      const user = await kit.identity(ctx.from);
      if (where === "here") {
        const scope = await dmScope(ctx);
        if (!scope) return;
        chatId = scope.chatId;
      }
      await setOptOut(sql, user.id, true, chatId);
      if (what === "messages") {
        await sql`
        UPDATE messages SET text = '', extracted_at = now()
        WHERE user_id = ${user.id} AND (${chatId ?? null}::bigint IS NULL OR chat_id = ${chatId ?? null}::bigint)`;
      }
      const scopeText = where === "here" ? " in this chat" : "";
      await ctx.editMessageText(
        what === "messages"
          ? `Deleted the facts and the text of your messages${scopeText}. I'm no longer collecting anything about you. Changed your mind? /me → 🔒 Privacy.`
          : `Deleted all facts${scopeText}. I'm no longer collecting anything about you. Changed your mind? /me → 🔒 Privacy.`,
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
    const [facts, projects] = await Promise.all([
      visibleFacts(sql, scope.chatId, scope.user.id),
      projectsOfUser(sql, scope.chatId, scope.user.id),
    ]);
    await kit.show(
      ctx,
      personCard(scope.person, facts, projects, { compact: true }),
      new InlineKeyboard().url(
        "✏️ Edit in DM",
        `https://t.me/${bot.botInfo.username}?start=${encodeChat(scope.chatId)}_me`,
      ),
    );
  });

  bot.callbackQuery("np:start", async (ctx) => {
    if (!kit.isPrivate(ctx))
      return ctx.answerCallbackQuery({
        text: "You can add a project in a DM with the bot",
      });
    await ctx.answerCallbackQuery();
    const scope = await dmScope(ctx);
    if (!scope) return;
    pending.set(ctx.from.id, {
      kind: "new_project_name",
      chatId: scope.chatId,
    });
    await kit.show(
      ctx,
      "🛠 <b>New project.</b> What's it called?",
      cancelKeyboard(),
      { edit: true },
    );
  });

  bot.callbackQuery(/^np:skip:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    pending.clear(ctx.from.id);
    const [project] = await sql<
      { slug: string }[]
    >`SELECT slug FROM projects WHERE id = ${Number(ctx.match[1])}`;
    if (project)
      await kit.show(
        ctx,
        `Done ✅ Open the project to add a description and stack: /project ${escapeHtml(project.slug)}`,
        new InlineKeyboard().text("Open project", `p:${project.slug}`),
        { edit: true },
      );
  });

  async function handleInput(
    ctx: BotContext,
    input: PendingInput,
    rawText: string,
  ) {
    const user = await kit.identity(ctx.from!);
    const person = await getPerson(sql, input.chatId, user.id);
    if (!person) return void (await ctx.reply("You're no longer in this chat 🤔"));
    const scope: Scope = { user, chatId: input.chatId, person };
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
        const { project } = await upsertProject(sql, {
          chatId: scope.chatId,
          name: text.slice(0, 80),
          status: "в работе",
          authorIds: [user.id],
          sourceMsgIds: [],
          activityAt: new Date(),
          source: "user",
          actorUserId: user.id,
        });
        pending.set(ctx.from!.id, {
          kind: "new_project_link",
          chatId: scope.chatId,
          projectId: project.id,
        });
        await kit.show(
          ctx,
          `Project <b>${escapeHtml(project.name)}</b> added ✅\nSend a link — repository or website:`,
          new InlineKeyboard().text("Skip", `np:skip:${project.id}`),
        );
        return;
      }
      case "new_project_link":
      case "project_field": {
        const projectId = input.projectId;
        const field = input.kind === "new_project_link" ? "links" : input.field;
        const [current] = await sql<
          { name: string; slug: string }[]
        >`SELECT name, slug FROM projects WHERE id = ${projectId} AND chat_id = ${scope.chatId}`;
        if (!current) return;
        if (field === "tagline") {
          await upsertProject(sql, {
            chatId: scope.chatId,
            name: current.name,
            tagline: text.slice(0, 200),
            authorIds: [],
            sourceMsgIds: [],
            source: "user",
            actorUserId: user.id,
          });
        } else if (field === "stack") {
          const stack = text
            .split(/[,;\n]+/)
            .map((part) => part.trim())
            .filter(Boolean)
            .slice(0, 20);
          await sql`UPDATE projects SET stack = ${stack}, manual_fields = array(SELECT DISTINCT unnest(manual_fields || '{stack}'::text[])), updated_at = now() WHERE id = ${projectId}`;
        } else {
          const urls = text.match(/https?:\/\/\S+/g) ?? [];
          if (urls.length === 0) {
            pending.set(ctx.from!.id, input);
            await ctx.reply(
              "I don't see a link. Send something like https://github.com/you/project",
              { reply_markup: cancelKeyboard() },
            );
            return;
          }
          const repo =
            urls.find((url) =>
              /github\.com|gitlab\.com|codeberg\.org/.test(url),
            ) ?? null;
          const site = urls.find((url) => url !== repo) ?? null;
          await upsertProject(sql, {
            chatId: scope.chatId,
            name: current.name,
            links: { repo, site },
            authorIds: [],
            sourceMsgIds: [],
            source: "user",
            actorUserId: user.id,
          });
        }
        await ctx.reply("Saved ✅", {
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
