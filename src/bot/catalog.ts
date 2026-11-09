import { InlineKeyboard } from "grammy";
import { visibleFacts, whoKnows } from "../core/facts.js";
import {
  canEditProject,
  findProject,
  getProjectBySlug,
  hideProject,
  listProjects,
  PROJECT_STATUSES,
  projectsOfUser,
  RATING_EXPLANATION,
  setVote,
  upsertProject,
  type ProjectSort,
} from "../core/projects.js";
import { topChronicle, topLimitFor } from "../core/chronicle.js";
import { escapeHtml, messageLink, normalizeUrl, truncate } from "../core/text.js";
import { findUserByRef, getUser, type User } from "../core/users.js";
import { chronicleLine, formatDate, personCard, projectCard, projectLine, STATUS_EMOJI } from "./format.js";
import { commandArgs, grid, pager, type BotContext, type BotKit } from "./kit.js";

const PEOPLE_PER_PAGE = 8;
const PROJECTS_PER_PAGE = 8;
const CHRONICLE_PER_PAGE = 5;
const LINKS_PER_PAGE = 10;

const SORT_LABELS: Record<ProjectSort, string> = { top: "🏆 Топ", alive: "🔥 Живые", new: "🆕 Новые" };

export function registerCatalog(kit: BotKit): { personScreen: (ctx: BotContext, userId: number, edit?: boolean) => Promise<void>; projectScreen: (ctx: BotContext, slug: string, edit?: boolean) => Promise<void> } {
  const { bot, sql, config, pending } = kit;
  const viewerOf = async (ctx: BotContext) => (ctx.from ? kit.identity(ctx.from) : undefined);

  // ---------- People ----------

  async function peopleScreen(ctx: BotContext, page: number, edit: boolean) {
    const people = await sql<(User & { project_count: number })[]>`
      SELECT u.*, (SELECT count(*)::int FROM project_members pm JOIN projects p ON p.id = pm.project_id WHERE pm.user_id = u.id AND NOT p.hidden) AS project_count
      FROM users u
      WHERE u.left_at IS NULL
      ORDER BY u.last_message_at DESC NULLS LAST, u.display_name`;
    const totalPages = Math.max(1, Math.ceil(people.length / PEOPLE_PER_PAGE));
    const current = Math.min(page, totalPages - 1);
    const slice = people.slice(current * PEOPLE_PER_PAGE, (current + 1) * PEOPLE_PER_PAGE);
    const lines = slice.map(
      (person) =>
        `• <b>${escapeHtml(person.display_name)}</b>${person.username ? ` @${escapeHtml(person.username)}` : ""}${
          person.tagline && !person.opted_out ? ` — ${escapeHtml(truncate(person.tagline, 70))}` : ""
        }${person.project_count ? ` · 🛠${person.project_count}` : ""}`,
    );
    const keyboard = grid(slice.map((person) => InlineKeyboard.text(person.display_name, `u:${person.id}`)), 2).row();
    for (const button of pager("pp", current, totalPages)) keyboard.add(button);
    const app = kit.appButton(ctx, "📱 Все в приложении", "/people", "people");
    if (app) keyboard.row().add(app);
    await kit.show(ctx, [`👥 <b>Участники чата</b> (${people.length})`, "", ...lines, "", "Нажми на имя — откроется карточка."].join("\n"), keyboard, { edit });
  }

  async function personScreen(ctx: BotContext, userId: number, edit = false) {
    const person = await getUser(sql, userId);
    if (!person) return void (await kit.show(ctx, "Не нашёл такого участника."));
    const [facts, projects] = await Promise.all([person.opted_out ? Promise.resolve([]) : visibleFacts(sql, person.id), projectsOfUser(sql, person.id)]);
    const keyboard = grid(projects.slice(0, 6).map((project) => InlineKeyboard.text(`${STATUS_EMOJI[project.status] ?? ""} ${project.name}`, `p:${project.slug}`)), 2);
    const viewer = await viewerOf(ctx);
    if (viewer?.id === person.id && kit.isPrivate(ctx)) keyboard.row().text("✏️ Править мою карточку", "me:home");
    keyboard.row().text("👥 Все участники", "pp:0");
    const app = kit.appButton(ctx, "📱 Подробнее", `/u/${person.id}`, `u_${person.id}`);
    if (app) keyboard.add(app);
    await kit.show(ctx, personCard(person, facts, projects, { compact: !kit.isPrivate(ctx) }), keyboard, { edit });
  }

  bot.command(["people", "members"], (ctx) => peopleScreen(ctx, 0, false));
  bot.callbackQuery(/^pp:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await peopleScreen(ctx, Number(ctx.match[1]), true);
  });
  bot.callbackQuery(/^u:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await personScreen(ctx, Number(ctx.match[1]), true);
  });

  bot.command("who", async (ctx) => {
    const ref = commandArgs(ctx);
    const replied = ctx.msg?.reply_to_message?.from;
    let target: User | undefined;
    if (ref) target = await findUserByRef(sql, ref);
    else if (replied && !replied.is_bot) target = await kit.identity(replied);
    else if (ctx.from) target = await kit.identity(ctx.from);
    if (!target) return void (await kit.show(ctx, `Не знаю, кто такой «${escapeHtml(ref)}». Попробуй @username, имя или ответь командой на его сообщение. Все участники — /people`));
    await personScreen(ctx, target.id);
  });

  bot.command("whoknows", async (ctx) => {
    const topic = commandArgs(ctx);
    if (!topic) return void (await kit.show(ctx, "Про что спросить? Например: /whoknows swift или /whoknows сервера"));
    const people = await whoKnows(sql, topic);
    if (people.length === 0) return void (await kit.show(ctx, `Пока не знаю, кто разбирается в «${escapeHtml(topic)}». Карточки пополняются по ходу общения.`));
    const lines = people.map(
      (person) => `• <b>${escapeHtml(person.display_name)}</b>${person.username ? ` @${escapeHtml(person.username)}` : ""} — ${person.matches.slice(0, 3).map(escapeHtml).join(", ")}`,
    );
    const keyboard = grid(people.map((person) => InlineKeyboard.text(person.display_name, `u:${person.user_id}`)), 2);
    await kit.show(ctx, [`🧠 <b>Кто шарит в «${escapeHtml(topic)}»</b>`, "", ...lines].join("\n"), keyboard);
  });

  // ---------- Projects ----------

  async function projectsScreen(ctx: BotContext, sort: ProjectSort, page: number, edit: boolean) {
    const viewer = await viewerOf(ctx);
    const projects = await listProjects(sql, { sort, viewerUserId: viewer?.id });
    if (projects.length === 0) {
      return void (await kit.show(ctx, "Каталог пока пуст. Добавь свой: /addproject ссылка описание", undefined, { edit }));
    }
    const totalPages = Math.max(1, Math.ceil(projects.length / PROJECTS_PER_PAGE));
    const current = Math.min(page, totalPages - 1);
    const slice = projects.slice(current * PROJECTS_PER_PAGE, (current + 1) * PROJECTS_PER_PAGE);
    const lines = slice.map((project, index) => projectLine(project, current * PROJECTS_PER_PAGE + index + 1));
    const keyboard = new InlineKeyboard();
    for (const key of Object.keys(SORT_LABELS) as ProjectSort[]) {
      keyboard.text(key === sort ? `· ${SORT_LABELS[key]} ·` : SORT_LABELS[key], `pl:${key}:0`);
    }
    keyboard.row();
    slice.forEach((project, index) => {
      keyboard.text(`${current * PROJECTS_PER_PAGE + index + 1}. ${project.name}`, `p:${project.slug}`);
      if (index % 2 === 1) keyboard.row();
    });
    keyboard.row();
    for (const button of pager(`pl:${sort}`, current, totalPages)) keyboard.add(button);
    keyboard.row().text("❓ Как считается рейтинг", "rating:help");
    if (kit.isPrivate(ctx)) keyboard.text("➕ Добавить свой", "np:start");
    await kit.show(ctx, [`🛠 <b>Проекты чата</b> · ${SORT_LABELS[sort]}`, "", ...lines].join("\n"), keyboard, { edit });
  }

  async function projectScreen(ctx: BotContext, slug: string, edit = false) {
    const viewer = await viewerOf(ctx);
    const project = await getProjectBySlug(sql, slug, viewer?.id);
    if (!project) return void (await kit.show(ctx, "Проект не найден — может, его удалили. Список: /projects", undefined, { edit }));
    const keyboard = new InlineKeyboard().text(project.voted_by_me ? `👍 ${project.votes} · убрать голос` : `👍 ${project.votes} · голосую`, `vote:${project.id}`).row();
    for (const author of project.authors.slice(0, 4)) keyboard.text(`👤 ${author.display_name}`, `u:${author.id}`);
    keyboard.row();
    if (viewer && kit.isPrivate(ctx) && (await canEditProject(sql, project.id, viewer.id, viewer.is_admin))) {
      keyboard
        .text("📌 Статус", `pe:${project.id}:status`)
        .text("📝 Описание", `pe:${project.id}:tagline`)
        .row()
        .text("🧰 Стек", `pe:${project.id}:stack`)
        .text("🔗 Ссылки", `pe:${project.id}:links`)
        .text("🗑", `pe:${project.id}:delete`)
        .row();
    }
    keyboard.text("← Проекты", "pl:top:0");
    const app = kit.appButton(ctx, "📱 Открыть", `/p/${project.slug}`, `p_${project.slug}`);
    if (app) keyboard.add(app);
    await kit.show(ctx, projectCard(project, config.CHAT_ID), keyboard, { edit });
  }

  bot.command(["projects", "top"], (ctx) => projectsScreen(ctx, "top", 0, false));
  bot.callbackQuery(/^pl:(top|alive|new):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await projectsScreen(ctx, ctx.match[1] as ProjectSort, Number(ctx.match[2]), true);
  });
  bot.callbackQuery(/^p:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await projectScreen(ctx, ctx.match[1]!, true);
  });
  bot.callbackQuery("rating:help", async (ctx) => {
    await ctx.answerCallbackQuery();
    await kit.show(ctx, RATING_EXPLANATION, new InlineKeyboard().text("← Проекты", "pl:top:0"), { edit: true });
  });

  bot.command("project", async (ctx) => {
    const query = commandArgs(ctx);
    if (!query) return projectsScreen(ctx, "top", 0, false);
    const project = await findProject(sql, query);
    if (!project) return void (await kit.show(ctx, `Не нашёл проект «${escapeHtml(query)}». Список — /projects`));
    await projectScreen(ctx, project.slug);
  });

  bot.callbackQuery(/^vote:(\d+)$/, async (ctx) => {
    const user = await kit.identity(ctx.from);
    const projectId = Number(ctx.match[1]);
    const [project] = await sql<{ slug: string; voted: boolean }[]>`
      SELECT slug, EXISTS (SELECT 1 FROM votes WHERE project_id = ${projectId} AND user_id = ${user.id}) AS voted
      FROM projects WHERE id = ${projectId}`;
    if (!project) return ctx.answerCallbackQuery({ text: "Проект не найден" });
    const result = await setVote(sql, projectId, user.id, !project.voted);
    if (result === "own_project") return ctx.answerCallbackQuery({ text: "За свой проект голосовать нельзя 🙂" });
    await ctx.answerCallbackQuery({ text: project.voted ? "Голос убран" : "Засчитано 👍" });
    await projectScreen(ctx, project.slug, true);
  });

  bot.callbackQuery(/^pe:(\d+):(status|tagline|stack|links|delete)$/, async (ctx) => {
    const user = await kit.identity(ctx.from);
    const projectId = Number(ctx.match[1]);
    if (!kit.isPrivate(ctx) || !(await canEditProject(sql, projectId, user.id, user.is_admin))) return ctx.answerCallbackQuery({ text: "Править может только автор, в личке с ботом" });
    await ctx.answerCallbackQuery();
    const [project] = await sql<{ slug: string; name: string; tagline: string | null; stack: string[] }[]>`SELECT slug, name, tagline, stack FROM projects WHERE id = ${projectId}`;
    if (!project) return;
    const back = new InlineKeyboard().text("Отмена", `p:${project.slug}`);
    switch (ctx.match[2]) {
      case "status":
        return void (await kit.show(
          ctx,
          `📌 Статус проекта <b>${escapeHtml(project.name)}</b>:`,
          grid(PROJECT_STATUSES.map((status, index) => InlineKeyboard.text(`${STATUS_EMOJI[status]} ${status}`, `ps:${projectId}:${index}`)), 2).row().text("Отмена", `p:${project.slug}`),
          { edit: true },
        ));
      case "tagline":
        pending.set(ctx.from.id, { kind: "project_field", projectId, field: "tagline" });
        return void (await kit.show(ctx, `📝 Опиши <b>${escapeHtml(project.name)}</b> одной фразой.\nСейчас: ${project.tagline ? escapeHtml(project.tagline) : "нет"}`, back, { edit: true }));
      case "stack":
        pending.set(ctx.from.id, { kind: "project_field", projectId, field: "stack" });
        return void (await kit.show(ctx, `🧰 Стек через запятую.\nСейчас: ${project.stack.length ? escapeHtml(project.stack.join(", ")) : "нет"}`, back, { edit: true }));
      case "links":
        pending.set(ctx.from.id, { kind: "project_field", projectId, field: "links" });
        return void (await kit.show(ctx, "🔗 Пришли ссылки — репозиторий и/или сайт (можно обе в одном сообщении).", back, { edit: true }));
      case "delete":
        return void (await kit.show(
          ctx,
          `Удалить <b>${escapeHtml(project.name)}</b> из каталога?`,
          new InlineKeyboard().text("Да, удалить", `pdel:${projectId}`).text("Отмена", `p:${project.slug}`),
          { edit: true },
        ));
    }
  });

  bot.callbackQuery(/^ps:(\d+):(\d)$/, async (ctx) => {
    const user = await kit.identity(ctx.from);
    const projectId = Number(ctx.match[1]);
    const status = PROJECT_STATUSES[Number(ctx.match[2])];
    if (!status || !(await canEditProject(sql, projectId, user.id, user.is_admin))) return ctx.answerCallbackQuery();
    const [project] = await sql<{ name: string; slug: string }[]>`SELECT name, slug FROM projects WHERE id = ${projectId}`;
    if (!project) return ctx.answerCallbackQuery();
    await upsertProject(sql, { name: project.name, status, authorIds: [], sourceMsgIds: [], activityAt: new Date(), source: user.is_admin ? "admin" : "user", actorUserId: user.id });
    await ctx.answerCallbackQuery({ text: `Статус: ${status}` });
    await projectScreen(ctx, project.slug, true);
  });

  bot.callbackQuery(/^pdel:(\d+)$/, async (ctx) => {
    const user = await kit.identity(ctx.from);
    const projectId = Number(ctx.match[1]);
    if (!(await canEditProject(sql, projectId, user.id, user.is_admin))) return ctx.answerCallbackQuery({ text: "Удалить может только автор" });
    await hideProject(sql, projectId, user.id);
    await ctx.answerCallbackQuery({ text: "Удалено" });
    await kit.show(ctx, "Проект удалён из каталога.", new InlineKeyboard().text("← Проекты", "pl:top:0"), { edit: true });
  });

  bot.command("addproject", async (ctx) => {
    if (!ctx.from) return;
    const [rawUrl, ...rest] = commandArgs(ctx).split(/\s+/);
    const normalized = rawUrl ? normalizeUrl(rawUrl) : null;
    if (!rawUrl || !normalized) {
      if (kit.isPrivate(ctx)) return void (await kit.show(ctx, "Можно ссылкой: /addproject https://github.com/you/repo Короткое описание — или по шагам:", new InlineKeyboard().text("➕ Новый проект", "np:start")));
      return void (await kit.show(ctx, "Формат: /addproject https://github.com/you/repo Короткое описание"));
    }
    const user = await kit.identity(ctx.from);
    const isRepo = ["github.com", "gitlab.com", "codeberg.org"].includes(normalized.domain);
    const pathParts = new URL(rawUrl).pathname.split("/").filter(Boolean);
    const name = isRepo && pathParts[1] ? pathParts[1] : normalized.domain.split(".")[0] ?? normalized.domain;
    const { project, created } = await upsertProject(sql, {
      name,
      tagline: rest.join(" ") || null,
      links: isRepo ? { repo: rawUrl } : { site: rawUrl },
      authorIds: [user.id],
      sourceMsgIds: ctx.msg && kit.isMainChat(ctx) ? [ctx.msg.message_id] : [],
      activityAt: new Date(),
      source: "user",
      actorUserId: user.id,
    });
    await kit.show(ctx, `${created ? "Добавил" : "Обновил"} проект <b>${escapeHtml(project.name)}</b> ✅`, new InlineKeyboard().text("Открыть карточку", `p:${project.slug}`));
  });

  // ---------- Chronicle ----------

  async function chronicleScreen(ctx: BotContext, days: number, page: number, edit: boolean) {
    const entries = await topChronicle(sql, new Date(Date.now() - days * 86_400_000), topLimitFor(days));
    const totalPages = Math.max(1, Math.ceil(entries.length / CHRONICLE_PER_PAGE));
    const current = Math.min(page, totalPages - 1);
    const slice = entries.slice(current * CHRONICLE_PER_PAGE, (current + 1) * CHRONICLE_PER_PAGE);
    const keyboard = new InlineKeyboard();
    for (const [value, label] of [[1, "Сутки"], [3, "3 дня"], [7, "Неделя"], [30, "Месяц"]] as const) {
      keyboard.text(value === days ? `· ${label} ·` : label, `ch:${value}:0`);
    }
    keyboard.row();
    for (const button of pager(`ch:${days}`, current, totalPages)) keyboard.add(button);
    const body = slice.length
      ? slice.map((entry) => `<i>${formatDate(entry.period_to, config.DISPLAY_TIMEZONE)}</i>\n${chronicleLine(entry, config.CHAT_ID)}`).join("\n\n")
      : `За этот период летопись пуста. Летописец садится за новые сообщения раз в ${config.EXTRACTION_INTERVAL_HOURS} ч.`;
    await kit.show(ctx, `📜 <b>Главное в чате</b>\n\n${body}`, keyboard, { edit });
  }

  bot.command(["chronicle", "today", "week"], async (ctx) => {
    const command = ctx.msg?.text?.split(/[\s@]/)[0]?.slice(1);
    const parsed = Number.parseInt(commandArgs(ctx), 10);
    const days = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 60) : command === "week" ? 7 : command === "today" ? 1 : 3;
    await chronicleScreen(ctx, days, 0, false);
  });
  bot.callbackQuery(/^ch:(\d+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await chronicleScreen(ctx, Number(ctx.match[1]), Number(ctx.match[2]), true);
  });

  // ---------- Links ----------

  async function linksScreen(ctx: BotContext, page: number, edit: boolean) {
    const [total] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM links WHERE NOT from_forward`;
    const totalPages = Math.max(1, Math.ceil((total?.count ?? 0) / LINKS_PER_PAGE));
    const current = Math.min(page, totalPages - 1);
    const links = await sql<{ url: string; context: string | null; last_msg_id: number | null; display_name: string | null; share_count: number }[]>`
      SELECT l.url, l.context, l.last_msg_id, u.display_name, l.share_count
      FROM links l LEFT JOIN users u ON u.id = l.first_user_id
      WHERE NOT l.from_forward
      ORDER BY l.first_seen_at DESC
      LIMIT ${LINKS_PER_PAGE} OFFSET ${current * LINKS_PER_PAGE}`;
    const lines = links.map((link) => {
      const where = link.last_msg_id ? ` <a href="${messageLink(config.CHAT_ID, link.last_msg_id)}">💬</a>` : "";
      const who = link.display_name ? ` — ${escapeHtml(link.display_name)}` : "";
      const context = link.context ? `\n   <i>${escapeHtml(truncate(link.context, 90))}</i>` : "";
      return `• ${escapeHtml(truncate(link.url.replace(/^https?:\/\//, ""), 70))}${who}${link.share_count > 1 ? ` ×${link.share_count}` : ""}${where}${context}`;
    });
    const keyboard = new InlineKeyboard();
    for (const button of pager("ln", current, totalPages)) keyboard.add(button);
    await kit.show(ctx, [`🔗 <b>Ссылки из чата</b> (свежие сверху)`, "", ...(lines.length ? lines : ["Пока пусто."])].join("\n"), keyboard, { edit });
  }

  bot.command("links", (ctx) => linksScreen(ctx, 0, false));
  bot.callbackQuery(/^ln:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await linksScreen(ctx, Number(ctx.match[1]), true);
  });

  bot.callbackQuery("noop", (ctx) => ctx.answerCallbackQuery());

  return { personScreen, projectScreen };
}
