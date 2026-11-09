import { InlineKeyboard } from "grammy";
import { FACT_KIND_LABELS, getFact, ownFacts, proposeFact, rejectFact, setFactHidden, visibleFacts, type FactKind } from "../core/facts.js";
import { projectsOfUser, upsertProject } from "../core/projects.js";
import { escapeHtml } from "../core/text.js";
import { setOptOut, setTagline, type User } from "../core/users.js";
import { factsWithSources, personCard, userHeader } from "./format.js";
import { grid, type BotContext, type BotKit, type PendingInput } from "./kit.js";

const MANUAL_KINDS: FactKind[] = ["role", "stack", "expertise", "interest", "looking_for", "can_help", "link", "timezone"];

const KIND_PROMPTS: Record<FactKind, string> = {
  role: "Чем занимаешься? Например: «бэкенд-разработчик», «3D-художник в геймдеве»",
  stack: "Чем пользуешься? Можно несколько через запятую: «Rust, Tauri, Claude Code»",
  expertise: "О чём тебя можно спросить? Например: «self-hosted VPN», «Unity-шейдеры»",
  interest: "Чем увлекаешься? Например: «скайдайвинг», «ретро-консоли»",
  looking_for: "Что ищешь? Например: «тестеров для бета-версии», «кофаундера-дизайнера»",
  can_help: "Чем можешь помочь другим? Например: «ревью архитектуры», «настройка серверов»",
  link: "Скинь ссылку: GitHub, сайт, портфолио, канал",
  timezone: "Где ты / какой часовой пояс? Например: «Берлин», «UTC+3»",
  project: "Опиши проект в двух словах",
};

const cancelKeyboard = () => new InlineKeyboard().text("Отмена", "me:cancel");

export function registerProfile(kit: BotKit): { handleInput: (ctx: BotContext, input: PendingInput, text: string) => Promise<void>; profileScreen: (ctx: BotContext, user: User, edit?: boolean) => Promise<void> } {
  const { bot, sql, config, pending } = kit;

  async function profileScreen(ctx: BotContext, user: User, edit = false) {
    const [facts, projects, hidden] = await Promise.all([
      visibleFacts(sql, user.id),
      projectsOfUser(sql, user.id),
      sql<{ count: number }[]>`SELECT count(*)::int AS count FROM facts WHERE user_id = ${user.id} AND status = 'hidden'`,
    ]);
    const hiddenCount = hidden[0]?.count ?? 0;
    const text = [
      personCard(user, facts, projects),
      "",
      user.opted_out
        ? "🚫 Сбор информации о тебе выключен."
        : "Эту карточку видят все участники. Летописец пополняет её сам по ходу общения, а ты можешь поправить что угодно.",
    ].join("\n");
    const keyboard = new InlineKeyboard();
    if (!user.opted_out) {
      keyboard.text("✏️ Однострочник", "me:tagline").text("➕ Добавить", "me:add").row();
      if (facts.length) keyboard.text("❌ Убрать неверное", "me:wrong").text("🙈 Скрыть", "me:hide").row();
      if (hiddenCount) keyboard.text(`👁 Скрытые (${hiddenCount})`, "me:hidden");
    }
    keyboard.text("🛠 Мои проекты", "me:projects").row();
    keyboard.text("🔒 Приватность", "me:privacy");
    const app = kit.appButton(ctx, "📱 В приложении", "/me", "me");
    if (app) keyboard.add(app);
    await kit.show(ctx, text, keyboard, { edit });
  }

  async function factListScreen(ctx: BotContext, user: User, mode: "wrong" | "hide" | "hidden") {
    const facts =
      mode === "hidden"
        ? (await ownFacts(sql, user.id)).filter((fact) => fact.status === "hidden")
        : await visibleFacts(sql, user.id);
    const title = {
      wrong: "❌ <b>Что неверно?</b> Нажми номер — факт исчезнет, и летописец больше его не добавит.",
      hide: "🙈 <b>Что скрыть?</b> Скрытое не видно другим, но его можно вернуть.",
      hidden: "👁 <b>Скрытые факты.</b> Нажми номер, чтобы вернуть в карточку.",
    }[mode];
    const action = { wrong: "rej", hide: "hide", hidden: "unhide" }[mode];
    const icon = { wrong: "❌", hide: "🙈", hidden: "↩️" }[mode];
    const buttons = facts.slice(0, 40).map((fact, index) => InlineKeyboard.text(`${icon} ${index + 1}`, `${action}:${fact.id}`));
    const keyboard = grid(buttons, 5).row().text("← Назад", "me:home");
    await kit.show(ctx, `${title}\n\n${factsWithSources(facts, config.CHAT_ID)}`, keyboard, { edit: true });
  }

  async function privacyScreen(ctx: BotContext, user: User) {
    const text = user.opted_out
      ? "🚫 <b>Сбор выключен.</b> Летописец ничего о тебе не записывает, карточки нет. Сообщения остаются в общем архиве чата."
      : [
          "🔒 <b>Приватность</b>",
          "Летописец раз в несколько часов разбирает новые сообщения и пополняет карточки. Он никогда не записывает политику, здоровье, финансы, личную жизнь, адреса и секреты.",
          "Каждый факт можно убрать кнопкой «❌ Убрать неверное».",
        ].join("\n\n");
    const keyboard = new InlineKeyboard().text("📋 Что ты обо мне знаешь", "me:know").row();
    if (user.opted_out) keyboard.text("✅ Снова вести мою карточку", "priv:on");
    else keyboard.text("🚫 Не собирать обо мне", "priv:off");
    keyboard.row().text("← Назад", "me:home");
    await kit.show(ctx, text, keyboard, { edit: true });
  }

  async function knowledgeScreen(ctx: BotContext, user: User, edit: boolean) {
    const facts = await ownFacts(sql, user.id);
    const [stats] = await sql<{ messages: number; first: Date | null }[]>`
      SELECT count(*)::int AS messages, min(sent_at) AS first FROM messages WHERE user_id = ${user.id}`;
    const text = [
      userHeader(user),
      user.tagline ? `Однострочник: ${escapeHtml(user.tagline)}${user.tagline_manual ? " ✍️" : ""}` : "Однострочника нет",
      `Сообщений в архиве: ${stats?.messages ?? 0}${stats?.first ? ` (с ${stats.first.toLocaleDateString("ru-RU")})` : ""}`,
      "",
      "<b>Факты</b> (✍️ — добавлены тобой, 🙈 — скрыты, цифры — сообщения-источники):",
      factsWithSources(facts, config.CHAT_ID),
      "",
      "Сообщения хранятся для летописи и /catchup. Удалить всё о себе — /forgetme.",
    ].join("\n");
    await kit.show(ctx, text, edit ? new InlineKeyboard().text("← Назад", "me:privacy") : undefined, { edit });
  }

  async function myProjectsScreen(ctx: BotContext, user: User) {
    const projects = await projectsOfUser(sql, user.id);
    const buttons = projects.map((project) => InlineKeyboard.text(project.name, `p:${project.slug}`));
    const keyboard = grid(buttons, 2).row().text("➕ Новый проект", "np:start").row().text("← Назад", "me:home");
    const text = projects.length
      ? "🛠 <b>Твои проекты</b>\nНажми на проект, чтобы поправить статус, описание, стек или ссылки."
      : "🛠 У тебя пока нет проектов в каталоге. Добавь — так о них узнают остальные, а проект попадёт в рейтинг.";
    await kit.show(ctx, text, keyboard, { edit: true });
  }

  const dmUser = async (ctx: BotContext) => (ctx.from && kit.isPrivate(ctx) ? kit.identity(ctx.from) : undefined);

  bot.callbackQuery(/^me:(home|tagline|tagline_reset|add|wrong|hide|hidden|privacy|know|projects|cancel)$/, async (ctx) => {
    const user = await dmUser(ctx);
    if (!user) return ctx.answerCallbackQuery({ text: "Это работает в личке с ботом" });
    await ctx.answerCallbackQuery();
    switch (ctx.match[1]) {
      case "home":
      case "cancel":
        pending.clear(ctx.from.id);
        return profileScreen(ctx, user, true);
      case "tagline":
        pending.set(ctx.from.id, { kind: "tagline" });
        return kit.show(
          ctx,
          `✏️ Напиши однострочник «кто ты» — до 90 символов.\nСейчас: ${user.tagline ? `<i>${escapeHtml(user.tagline)}</i>` : "нет"}`,
          new InlineKeyboard().text("Сбросить", "me:tagline_reset").text("Отмена", "me:cancel"),
          { edit: true },
        );
      case "tagline_reset":
        pending.clear(ctx.from.id);
        await setTagline(sql, user.id, null, user.id);
        return profileScreen(ctx, { ...user, tagline: null, tagline_manual: false }, true);
      case "add":
        return kit.show(
          ctx,
          "➕ <b>Что добавить?</b>",
          grid(MANUAL_KINDS.map((kind) => InlineKeyboard.text(FACT_KIND_LABELS[kind], `addk:${kind}`)), 2).row().text("← Назад", "me:home"),
          { edit: true },
        );
      case "wrong":
      case "hide":
      case "hidden":
        return factListScreen(ctx, user, ctx.match[1]);
      case "privacy":
        return privacyScreen(ctx, user);
      case "know":
        return knowledgeScreen(ctx, user, true);
      case "projects":
        return myProjectsScreen(ctx, user);
    }
  });

  bot.callbackQuery(/^addk:(\w+)$/, async (ctx) => {
    const user = await dmUser(ctx);
    const kind = ctx.match[1] as FactKind;
    if (!user || !MANUAL_KINDS.includes(kind)) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    pending.set(ctx.from.id, { kind: "fact", factKind: kind });
    await kit.show(ctx, `<b>${FACT_KIND_LABELS[kind]}</b>\n${escapeHtml(KIND_PROMPTS[kind])}`, cancelKeyboard(), { edit: true });
  });

  bot.callbackQuery(/^(rej|hide|unhide):(\d+)$/, async (ctx) => {
    const user = await kit.identity(ctx.from);
    const fact = await getFact(sql, Number(ctx.match[2]));
    if (!fact || (fact.user_id !== user.id && !user.is_admin)) return ctx.answerCallbackQuery({ text: "Это не твой факт" });
    const source = fact.user_id === user.id ? "user" : "admin";
    const action = ctx.match[1];
    if (action === "rej") await rejectFact(sql, fact.id, user.id, source);
    else await setFactHidden(sql, fact.id, action === "hide", user.id, source);
    await ctx.answerCallbackQuery({ text: action === "rej" ? "Убрал и больше не верну 👌" : action === "hide" ? "Скрыл 🙈" : "Вернул 👁" });
    if (fact.user_id === user.id && kit.isPrivate(ctx)) await factListScreen(ctx, user, action === "rej" ? "wrong" : action === "hide" ? "hide" : "hidden");
  });

  bot.callbackQuery(/^priv:(on|off)$/, async (ctx) => {
    const user = await dmUser(ctx);
    if (!user) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    if (ctx.match[1] === "on") {
      await setOptOut(sql, user.id, false);
      return privacyScreen(ctx, { ...user, opted_out: false });
    }
    await kit.show(ctx, forgetPrompt, forgetKeyboard(), { edit: true });
  });

  const forgetPrompt =
    "Удалить все факты о тебе и больше ничего не собирать? Сообщения останутся в архиве поиска, но карточки у тебя не будет. Можно удалить и тексты твоих сообщений.";
  const forgetKeyboard = () =>
    new InlineKeyboard().text("Да, удалить факты", "forget:all").row().text("Удалить и тексты сообщений", "forget:messages").row().text("Отмена", "forget:no");

  bot.command("forgetme", async (ctx) => {
    if (!kit.isPrivate(ctx)) return kit.show(ctx, "Это в личку: напиши мне /forgetme");
    await kit.show(ctx, forgetPrompt, forgetKeyboard());
  });

  bot.callbackQuery(/^forget:(all|messages|no)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (ctx.match[1] === "no") return ctx.editMessageText("Окей, ничего не трогаю 🙂");
    const user = await kit.identity(ctx.from);
    await setOptOut(sql, user.id, true);
    if (ctx.match[1] === "messages") await sql`UPDATE messages SET text = '', extracted_at = now() WHERE user_id = ${user.id}`;
    await ctx.editMessageText(
      ctx.match[1] === "messages"
        ? "Удалил факты и тексты твоих сообщений. Больше ничего о тебе не собираю. Передумаешь — /me → 🔒 Приватность."
        : "Удалил все факты. Больше ничего о тебе не собираю. Передумаешь — /me → 🔒 Приватность.",
    );
  });

  bot.command("whatyouknow", async (ctx) => {
    if (!ctx.from) return;
    if (!kit.isPrivate(ctx)) return kit.show(ctx, "Это в личку: напиши мне /whatyouknow 🙂");
    await knowledgeScreen(ctx, await kit.identity(ctx.from), false);
  });

  bot.command("me", async (ctx) => {
    if (!ctx.from) return;
    const user = await kit.identity(ctx.from);
    if (kit.isPrivate(ctx)) return profileScreen(ctx, user);
    const [facts, projects] = await Promise.all([visibleFacts(sql, user.id), projectsOfUser(sql, user.id)]);
    await kit.show(ctx, personCard(user, facts, projects, { compact: true }), new InlineKeyboard().url("✏️ Править в личке", `https://t.me/${bot.botInfo.username}?start=me`));
  });

  bot.callbackQuery("np:start", async (ctx) => {
    const user = await dmUser(ctx);
    if (!user) return ctx.answerCallbackQuery({ text: "Добавить проект можно в личке с ботом" });
    await ctx.answerCallbackQuery();
    pending.set(ctx.from.id, { kind: "new_project_name" });
    await kit.show(ctx, "🛠 <b>Новый проект.</b> Как он называется?", cancelKeyboard(), { edit: true });
  });

  bot.callbackQuery(/^np:skip:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    pending.clear(ctx.from.id);
    const [project] = await sql<{ slug: string }[]>`SELECT slug FROM projects WHERE id = ${Number(ctx.match[1])}`;
    if (project) await kit.show(ctx, `Готово ✅ Открой проект, чтобы добавить описание и стек: /project ${escapeHtml(project.slug)}`, new InlineKeyboard().text("Открыть проект", `p:${project.slug}`), { edit: true });
  });

  async function handleInput(ctx: BotContext, input: PendingInput, rawText: string) {
    const user = await kit.identity(ctx.from!);
    const text = rawText.trim();
    switch (input.kind) {
      case "tagline": {
        await setTagline(sql, user.id, text.slice(0, 90), user.id);
        await ctx.reply("Однострочник обновлён ✅");
        return profileScreen(ctx, { ...user, tagline: text.slice(0, 90), tagline_manual: true });
      }
      case "fact": {
        const kind = input.factKind as FactKind;
        const values = kind === "stack" || kind === "interest" || kind === "expertise" ? text.split(/[,;\n]+/) : [text];
        let added = 0;
        for (const value of values.map((part) => part.trim()).filter(Boolean).slice(0, 10)) {
          const result = await proposeFact(sql, { userId: user.id, kind, value, confidence: 1, sourceMsgIds: [], source: "user", actorUserId: user.id });
          if (result === "added" || result === "reinforced") added += 1;
        }
        await ctx.reply(added ? `Добавил ✅ (${added})` : "Ничего не добавил — может, это уже есть в карточке?");
        return profileScreen(ctx, user);
      }
      case "new_project_name": {
        const { project } = await upsertProject(sql, {
          name: text.slice(0, 80),
          status: "в работе",
          authorIds: [user.id],
          sourceMsgIds: [],
          activityAt: new Date(),
          source: "user",
          actorUserId: user.id,
        });
        pending.set(ctx.from!.id, { kind: "new_project_link", projectId: project.id });
        await kit.show(ctx, `Проект <b>${escapeHtml(project.name)}</b> добавлен ✅\nСкинь ссылку — репозиторий или сайт:`, new InlineKeyboard().text("Пропустить", `np:skip:${project.id}`));
        return;
      }
      case "new_project_link":
      case "project_field": {
        const projectId = input.projectId;
        const field = input.kind === "new_project_link" ? "links" : input.field;
        const [current] = await sql<{ name: string; slug: string }[]>`SELECT name, slug FROM projects WHERE id = ${projectId}`;
        if (!current) return;
        if (field === "tagline") {
          await upsertProject(sql, { name: current.name, tagline: text.slice(0, 200), authorIds: [], sourceMsgIds: [], source: "user", actorUserId: user.id });
        } else if (field === "stack") {
          const stack = text.split(/[,;\n]+/).map((part) => part.trim()).filter(Boolean).slice(0, 20);
          await sql`UPDATE projects SET stack = ${stack}, manual_fields = array(SELECT DISTINCT unnest(manual_fields || '{stack}'::text[])), updated_at = now() WHERE id = ${projectId}`;
        } else {
          const urls = text.match(/https?:\/\/\S+/g) ?? [];
          if (urls.length === 0) {
            pending.set(ctx.from!.id, input);
            await ctx.reply("Не вижу ссылки. Пришли что-то вроде https://github.com/you/project", { reply_markup: cancelKeyboard() });
            return;
          }
          const repo = urls.find((url) => /github\.com|gitlab\.com|codeberg\.org/.test(url)) ?? null;
          const site = urls.find((url) => url !== repo) ?? null;
          await upsertProject(sql, { name: current.name, links: { repo, site }, authorIds: [], sourceMsgIds: [], source: "user", actorUserId: user.id });
        }
        await ctx.reply("Сохранил ✅", { reply_markup: new InlineKeyboard().text("Открыть проект", `p:${current.slug}`) });
        return;
      }
    }
  }

  return { handleInput, profileScreen };
}
