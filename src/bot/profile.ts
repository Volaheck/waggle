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
  role: "Чем занимаешься? Например: «бэкенд-разработчик», «3D-художник в геймдеве»",
  stack:
    "Чем пользуешься? Можно несколько через запятую: «Rust, Tauri, Claude Code»",
  expertise:
    "О чём тебя можно спросить? Например: «self-hosted VPN», «Unity-шейдеры»",
  interest: "Чем увлекаешься? Например: «скайдайвинг», «ретро-консоли»",
  looking_for:
    "Что ищешь? Например: «тестеров для бета-версии», «кофаундера-дизайнера»",
  can_help:
    "Чем можешь помочь другим? Например: «ревью архитектуры», «настройка серверов»",
  link: "Скинь ссылку: GitHub, сайт, портфолио, канал",
  timezone: "Где ты / какой часовой пояс? Например: «Берлин», «UTC+3»",
  project: "Опиши проект в двух словах",
};

const cancelKeyboard = () => new InlineKeyboard().text("Отмена", "me:cancel");

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
        ? "🚫 Сбор информации о тебе в этом чате выключен."
        : "Эту карточку видят участники чата. Летописец пополняет её сам по ходу общения, а ты можешь поправить что угодно.",
      chats.length > 1 && chatTitle
        ? `\n💬 Чат: <b>${escapeHtml(chatTitle)}</b>`
        : "",
    ]
      .join("\n")
      .trim();
    const keyboard = new InlineKeyboard();
    if (!person.opted_out) {
      keyboard
        .text("✏️ Однострочник", "me:tagline")
        .text("➕ Добавить", "me:add")
        .row();
      if (facts.length)
        keyboard
          .text("❌ Убрать неверное", "me:wrong")
          .text("🙈 Скрыть", "me:hide")
          .row();
      if (hiddenCount) keyboard.text(`👁 Скрытые (${hiddenCount})`, "me:hidden");
    }
    keyboard.text("🛠 Мои проекты", "me:projects").row();
    keyboard.text("🔒 Приватность", "me:privacy");
    const app = kit.appButton(ctx, chatId, "📱 В приложении", "/me", "me");
    if (app) keyboard.add(app);
    if (chats.length > 1) keyboard.row().text("🔁 Другой чат", "chat:pick");
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
        "❌ <b>Что неверно?</b> Нажми номер — факт исчезнет, и летописец больше его не добавит.",
      hide: "🙈 <b>Что скрыть?</b> Скрытое не видно другим, но его можно вернуть.",
      hidden: "👁 <b>Скрытые факты.</b> Нажми номер, чтобы вернуть в карточку.",
    }[mode];
    const action = { wrong: "rej", hide: "hide", hidden: "unhide" }[mode];
    const icon = { wrong: "❌", hide: "🙈", hidden: "↩️" }[mode];
    const buttons = facts
      .slice(0, 40)
      .map((fact, index) =>
        InlineKeyboard.text(`${icon} ${index + 1}`, `${action}:${fact.id}`),
      );
    const keyboard = grid(buttons, 5).row().text("← Назад", "me:home");
    await kit.show(
      ctx,
      `${title}\n\n${factsWithSources(facts, scope.chatId)}`,
      keyboard,
      { edit: true },
    );
  }

  async function privacyScreen(ctx: BotContext, scope: Scope) {
    const text = scope.person.opted_out
      ? "🚫 <b>Сбор выключен.</b> Летописец ничего о тебе в этом чате не записывает, карточки нет. Сообщения остаются в общем архиве чата."
      : [
          "🔒 <b>Приватность</b>",
          "Летописец раз в несколько часов разбирает новые сообщения и пополняет карточки. Он никогда не записывает политику, здоровье, финансы, личную жизнь, адреса и секреты.",
          "Каждый факт можно убрать кнопкой «❌ Убрать неверное».",
        ].join("\n\n");
    const keyboard = new InlineKeyboard()
      .text("📋 Что ты обо мне знаешь", "me:know")
      .row();
    if (scope.person.opted_out)
      keyboard.text("✅ Снова вести мою карточку", "priv:on");
    else keyboard.text("🚫 Не собирать обо мне", "priv:off");
    keyboard.row().text("← Назад", "me:home");
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
        ? `Однострочник: ${escapeHtml(person.tagline)}${person.tagline_manual ? " ✍️" : ""}`
        : "Однострочника нет",
      `Сообщений в архиве этого чата: ${stats?.messages ?? 0}${stats?.first ? ` (с ${stats.first.toLocaleDateString("ru-RU")})` : ""}`,
      "",
      "<b>Факты</b> (✍️ — добавлены тобой, 🙈 — скрыты, цифры — сообщения-источники):",
      factsWithSources(facts, chatId),
      "",
      "Сообщения хранятся для летописи и /catchup. Удалить всё о себе во всех чатах — /forgetme.",
    ].join("\n");
    await kit.show(
      ctx,
      text,
      edit ? new InlineKeyboard().text("← Назад", "me:privacy") : undefined,
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
      .text("➕ Новый проект", "np:start")
      .row()
      .text("← Назад", "me:home");
    const text = projects.length
      ? "🛠 <b>Твои проекты</b>\nНажми на проект, чтобы поправить статус, описание, стек или ссылки."
      : "🛠 У тебя пока нет проектов в каталоге. Добавь — так о них узнают остальные, а проект попадёт в рейтинг.";
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
          text: "Это работает в личке с ботом",
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
            `✏️ Напиши однострочник «кто ты» — до 90 символов.\nСейчас: ${scope.person.tagline ? `<i>${escapeHtml(scope.person.tagline)}</i>` : "нет"}`,
            new InlineKeyboard()
              .text("Сбросить", "me:tagline_reset")
              .text("Отмена", "me:cancel"),
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
            "➕ <b>Что добавить?</b>",
            grid(
              MANUAL_KINDS.map((kind) =>
                InlineKeyboard.text(FACT_KIND_LABELS[kind], `addk:${kind}`),
              ),
              2,
            )
              .row()
              .text("← Назад", "me:home"),
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
      return ctx.answerCallbackQuery({ text: "Это не твой факт" });
    const source = isOwn ? "user" : "admin";
    const action = ctx.match[1];
    if (action === "rej") await rejectFact(sql, fact.id, user.id, source);
    else await setFactHidden(sql, fact.id, action === "hide", user.id, source);
    await ctx.answerCallbackQuery({
      text:
        action === "rej"
          ? "Убрал и больше не верну 👌"
          : action === "hide"
            ? "Скрыл 🙈"
            : "Вернул 👁",
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
      ? "Удалить все факты о тебе в этом чате и больше ничего в нём не собирать? Можно удалить и тексты твоих сообщений из архива этого чата."
      : "Удалить все факты о тебе во всех чатах и больше ничего не собирать? Можно удалить и тексты твоих сообщений из архивов.";
  const forgetKeyboard = (where: "here" | "all") =>
    new InlineKeyboard()
      .text("Да, удалить факты", `forget:${where}:facts`)
      .row()
      .text("Удалить и тексты сообщений", `forget:${where}:messages`)
      .row()
      .text("Отмена", "forget:no");

  bot.command("forgetme", async (ctx) => {
    if (!kit.isPrivate(ctx))
      return kit.show(ctx, "Это в личку: напиши мне /forgetme");
    await kit.show(ctx, forgetPrompt("all"), forgetKeyboard("all"));
  });

  bot.callbackQuery(
    /^forget:(?:(here|all):(facts|messages)|no)$/,
    async (ctx) => {
      await ctx.answerCallbackQuery();
      const [, where, what] = ctx.match;
      if (!where) return ctx.editMessageText("Окей, ничего не трогаю 🙂");
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
      const scopeText = where === "here" ? " в этом чате" : "";
      await ctx.editMessageText(
        what === "messages"
          ? `Удалил факты и тексты твоих сообщений${scopeText}. Больше ничего о тебе не собираю. Передумаешь — /me → 🔒 Приватность.`
          : `Удалил все факты${scopeText}. Больше ничего о тебе не собираю. Передумаешь — /me → 🔒 Приватность.`,
      );
    },
  );

  bot.command("whatyouknow", async (ctx) => {
    if (!ctx.from) return;
    if (!kit.isPrivate(ctx))
      return kit.show(ctx, "Это в личку: напиши мне /whatyouknow 🙂");
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
        "✏️ Править в личке",
        `https://t.me/${bot.botInfo.username}?start=${encodeChat(scope.chatId)}_me`,
      ),
    );
  });

  bot.callbackQuery("np:start", async (ctx) => {
    if (!kit.isPrivate(ctx))
      return ctx.answerCallbackQuery({
        text: "Добавить проект можно в личке с ботом",
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
      "🛠 <b>Новый проект.</b> Как он называется?",
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
        `Готово ✅ Открой проект, чтобы добавить описание и стек: /project ${escapeHtml(project.slug)}`,
        new InlineKeyboard().text("Открыть проект", `p:${project.slug}`),
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
    if (!person) return void (await ctx.reply("Ты больше не в этом чате 🤔"));
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
        await ctx.reply("Однострочник обновлён ✅");
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
            ? `Добавил ✅ (${added})`
            : "Ничего не добавил — может, это уже есть в карточке?",
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
          `Проект <b>${escapeHtml(project.name)}</b> добавлен ✅\nСкинь ссылку — репозиторий или сайт:`,
          new InlineKeyboard().text("Пропустить", `np:skip:${project.id}`),
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
              "Не вижу ссылки. Пришли что-то вроде https://github.com/you/project",
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
        await ctx.reply("Сохранил ✅", {
          reply_markup: new InlineKeyboard().text(
            "Открыть проект",
            `p:${current.slug}`,
          ),
        });
        return;
      }
    }
  }

  return { handleInput, profileScreen };
}
