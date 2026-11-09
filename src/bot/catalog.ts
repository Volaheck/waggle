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
  STATUS_LABELS,
  upsertProject,
  type ProjectSort,
} from "../core/projects.js";
import { topChronicle, topLimitFor } from "../core/chronicle.js";
import {
  escapeHtml,
  messageLink,
  normalizeUrl,
  truncate,
} from "../core/text.js";
import {
  findPersonByRef,
  getPerson,
  peopleOfChat,
  type Person,
} from "../core/users.js";
import {
  chronicleLine,
  formatDate,
  personCard,
  projectCard,
  projectLine,
  STATUS_EMOJI,
} from "./format.js";
import {
  commandArgs,
  grid,
  pager,
  type BotContext,
  type BotKit,
  type Scope,
} from "./kit.js";

const PEOPLE_PER_PAGE = 8;
const PROJECTS_PER_PAGE = 8;
const CHRONICLE_PER_PAGE = 5;
const LINKS_PER_PAGE = 10;

const SORT_LABELS: Record<ProjectSort, string> = {
  top: "🏆 Top",
  alive: "🔥 Active",
  new: "🆕 New",
};

export interface CatalogHandlers {
  personScreen: (
    ctx: BotContext,
    scope: Scope,
    userId: number,
    edit?: boolean,
  ) => Promise<void>;
  projectScreen: (
    ctx: BotContext,
    scope: Scope,
    slug: string,
    edit?: boolean,
  ) => Promise<void>;
  chronicleScreen: (
    ctx: BotContext,
    scope: Scope,
    days: number,
    page: number,
    edit: boolean,
  ) => Promise<void>;
}

export function registerCatalog(kit: BotKit): CatalogHandlers {
  const { bot, sql, config, pending } = kit;

  /** Runs a screen for the chat the update is about; in DM the picker may answer instead. */
  const scoped =
    <T extends unknown[]>(
      screen: (ctx: BotContext, scope: Scope, ...args: T) => Promise<unknown>,
    ) =>
    async (ctx: BotContext, ...args: T) => {
      if (ctx.callbackQuery)
        await ctx.answerCallbackQuery().catch(() => undefined);
      const scope = await kit.scope(ctx);
      if (scope) await screen(ctx, scope, ...args);
    };

  // ---------- People ----------

  async function peopleScreen(
    ctx: BotContext,
    scope: Scope,
    page: number,
    edit: boolean,
  ) {
    const [people, counts] = await Promise.all([
      peopleOfChat(sql, scope.chatId),
      sql<{ user_id: number; count: number }[]>`
        SELECT pm.user_id, count(*)::int AS count FROM project_members pm JOIN projects p ON p.id = pm.project_id
        WHERE p.chat_id = ${scope.chatId} AND NOT p.hidden GROUP BY pm.user_id`,
    ]);
    const projectCount = new Map(counts.map((row) => [row.user_id, row.count]));
    const totalPages = Math.max(1, Math.ceil(people.length / PEOPLE_PER_PAGE));
    const current = Math.min(page, totalPages - 1);
    const slice = people.slice(
      current * PEOPLE_PER_PAGE,
      (current + 1) * PEOPLE_PER_PAGE,
    );
    const lines = slice.map(
      (person) =>
        `• <b>${escapeHtml(person.display_name)}</b>${person.username ? ` @${escapeHtml(person.username)}` : ""}${
          person.tagline && !person.opted_out
            ? ` — ${escapeHtml(truncate(person.tagline, 70))}`
            : ""
        }${projectCount.get(person.id) ? ` · 🛠${projectCount.get(person.id)}` : ""}`,
    );
    const keyboard = grid(
      slice.map((person) =>
        InlineKeyboard.text(person.display_name, `u:${person.id}`),
      ),
      2,
    ).row();
    for (const button of pager("pp", current, totalPages)) keyboard.add(button);
    const app = kit.appButton(
      ctx,
      scope.chatId,
      "📱 All in the app",
      "/people",
      "people",
    );
    if (app) keyboard.row().add(app);
    await kit.show(
      ctx,
      [
        `👥 <b>Chat members</b> (${people.length})`,
        "",
        ...lines,
        "",
        "Tap a name to open their card.",
      ].join("\n"),
      keyboard,
      { edit },
    );
  }

  async function personScreen(
    ctx: BotContext,
    scope: Scope,
    userId: number,
    edit = false,
  ) {
    const person = await getPerson(sql, scope.chatId, userId);
    if (!person)
      return void (await kit.show(
        ctx,
        "Couldn't find that member in this chat.",
      ));
    const [facts, projects] = await Promise.all([
      person.opted_out
        ? Promise.resolve([])
        : visibleFacts(sql, scope.chatId, person.id),
      projectsOfUser(sql, scope.chatId, person.id),
    ]);
    const keyboard = grid(
      projects
        .slice(0, 6)
        .map((project) =>
          InlineKeyboard.text(
            `${STATUS_EMOJI[project.status] ?? ""} ${project.name}`,
            `p:${project.slug}`,
          ),
        ),
      2,
    );
    if (scope.user.id === person.id && kit.isPrivate(ctx))
      keyboard.row().text("✏️ Edit my card", "me:home");
    keyboard.row().text("👥 All members", "pp:0");
    const app = kit.appButton(
      ctx,
      scope.chatId,
      "📱 More",
      `/u/${person.id}`,
      `u_${person.id}`,
    );
    if (app) keyboard.add(app);
    await kit.show(
      ctx,
      personCard(person, facts, projects, { compact: !kit.isPrivate(ctx) }),
      keyboard,
      { edit },
    );
  }

  const people = scoped(peopleScreen);
  const person = scoped(personScreen);
  bot.command(["people", "members"], (ctx) => people(ctx, 0, false));
  bot.callbackQuery(/^pp:(\d+)$/, (ctx) =>
    people(ctx, Number(ctx.match[1]), true),
  );
  bot.callbackQuery(/^u:(\d+)$/, (ctx) =>
    person(ctx, Number(ctx.match[1]), true),
  );

  bot.command(
    "who",
    scoped(async (ctx, scope) => {
      const ref = commandArgs(ctx);
      const replied = ctx.msg?.reply_to_message?.from;
      let targetId: number | undefined;
      if (ref) targetId = (await findPersonByRef(sql, scope.chatId, ref))?.id;
      else if (replied && !replied.is_bot)
        targetId = (await kit.identity(replied, scope.chatId)).id;
      else targetId = scope.user.id;
      if (!targetId)
        return void (await kit.show(
          ctx,
          `I don't know who “${escapeHtml(ref)}” is. Try an @username, a name, or reply to their message with the command. All members — /people`,
        ));
      await personScreen(ctx, scope, targetId);
    }),
  );

  bot.command(
    "whoknows",
    scoped(async (ctx, scope) => {
      const topic = commandArgs(ctx);
      if (!topic)
        return void (await kit.show(
          ctx,
          "Ask about what? For example: /whoknows swift or /whoknows docker",
        ));
      const people = await whoKnows(sql, scope.chatId, topic);
      if (people.length === 0)
        return void (await kit.show(
          ctx,
          `I don't know yet who's into “${escapeHtml(topic)}”. Cards fill in as people chat.`,
        ));
      const lines = people.map(
        (person) =>
          `• <b>${escapeHtml(person.display_name)}</b>${person.username ? ` @${escapeHtml(person.username)}` : ""} — ${person.matches.slice(0, 3).map(escapeHtml).join(", ")}`,
      );
      const keyboard = grid(
        people.map((person) =>
          InlineKeyboard.text(person.display_name, `u:${person.user_id}`),
        ),
        2,
      );
      await kit.show(
        ctx,
        [`🧠 <b>Who knows “${escapeHtml(topic)}”</b>`, "", ...lines].join(
          "\n",
        ),
        keyboard,
      );
    }),
  );

  // ---------- Projects ----------

  async function projectsScreen(
    ctx: BotContext,
    scope: Scope,
    sort: ProjectSort,
    page: number,
    edit: boolean,
  ) {
    const projects = await listProjects(sql, scope.chatId, {
      sort,
      viewerUserId: scope.user.id,
    });
    if (projects.length === 0) {
      return void (await kit.show(
        ctx,
        "The catalog is empty for now. Add yours: /addproject link description",
        undefined,
        { edit },
      ));
    }
    const totalPages = Math.max(
      1,
      Math.ceil(projects.length / PROJECTS_PER_PAGE),
    );
    const current = Math.min(page, totalPages - 1);
    const slice = projects.slice(
      current * PROJECTS_PER_PAGE,
      (current + 1) * PROJECTS_PER_PAGE,
    );
    const lines = slice.map((project, index) =>
      projectLine(project, current * PROJECTS_PER_PAGE + index + 1),
    );
    const keyboard = new InlineKeyboard();
    for (const key of Object.keys(SORT_LABELS) as ProjectSort[]) {
      keyboard.text(
        key === sort ? `· ${SORT_LABELS[key]} ·` : SORT_LABELS[key],
        `pl:${key}:0`,
      );
    }
    keyboard.row();
    slice.forEach((project, index) => {
      keyboard.text(
        `${current * PROJECTS_PER_PAGE + index + 1}. ${project.name}`,
        `p:${project.slug}`,
      );
      if (index % 2 === 1) keyboard.row();
    });
    keyboard.row();
    for (const button of pager(`pl:${sort}`, current, totalPages))
      keyboard.add(button);
    keyboard.row().text("❓ How the rating works", "rating:help");
    if (kit.isPrivate(ctx)) keyboard.text("➕ Add yours", "np:start");
    await kit.show(
      ctx,
      [`🛠 <b>Chat projects</b> · ${SORT_LABELS[sort]}`, "", ...lines].join("\n"),
      keyboard,
      { edit },
    );
  }

  async function projectScreen(
    ctx: BotContext,
    scope: Scope,
    slug: string,
    edit = false,
  ) {
    const viewer = scope.user;
    const project = await getProjectBySlug(sql, scope.chatId, slug, viewer.id);
    if (!project)
      return void (await kit.show(
        ctx,
        "Project not found — maybe it was deleted. The list: /projects",
        undefined,
        { edit },
      ));
    const keyboard = new InlineKeyboard()
      .text(
        project.voted_by_me
          ? `👍 ${project.votes} · remove vote`
          : `👍 ${project.votes} · vote`,
        `vote:${project.id}`,
      )
      .row();
    for (const author of project.authors.slice(0, 4))
      keyboard.text(`👤 ${author.display_name}`, `u:${author.id}`);
    keyboard.row();
    if (
      kit.isPrivate(ctx) &&
      (await canEditProject(sql, project.id, viewer.id, kit.isOwner(viewer)))
    ) {
      keyboard
        .text("📌 Status", `pe:${project.id}:status`)
        .text("📝 Description", `pe:${project.id}:tagline`)
        .row()
        .text("🧰 Stack", `pe:${project.id}:stack`)
        .text("🔗 Links", `pe:${project.id}:links`)
        .text("🗑", `pe:${project.id}:delete`)
        .row();
    }
    keyboard.text("← Projects", "pl:top:0");
    const app = kit.appButton(
      ctx,
      scope.chatId,
      "📱 Open",
      `/p/${project.slug}`,
      `p_${project.slug}`,
    );
    if (app) keyboard.add(app);
    await kit.show(ctx, projectCard(project, scope.chatId), keyboard, { edit });
  }

  const projects = scoped(projectsScreen);
  const project = scoped(projectScreen);
  bot.command(["projects", "top"], (ctx) => projects(ctx, "top", 0, false));
  bot.callbackQuery(/^pl:(top|alive|new):(\d+)$/, (ctx) =>
    projects(ctx, ctx.match[1] as ProjectSort, Number(ctx.match[2]), true),
  );
  bot.callbackQuery(/^p:(.+)$/, (ctx) => project(ctx, ctx.match[1]!, true));
  bot.callbackQuery("rating:help", async (ctx) => {
    await ctx.answerCallbackQuery();
    await kit.show(
      ctx,
      RATING_EXPLANATION,
      new InlineKeyboard().text("← Projects", "pl:top:0"),
      { edit: true },
    );
  });

  bot.command(
    "project",
    scoped(async (ctx, scope) => {
      const query = commandArgs(ctx);
      if (!query) return projectsScreen(ctx, scope, "top", 0, false);
      const found = await findProject(sql, scope.chatId, query);
      if (!found)
        return void (await kit.show(
          ctx,
          `Couldn't find a project called “${escapeHtml(query)}”. The list — /projects`,
        ));
      await projectScreen(ctx, scope, found.slug);
    }),
  );

  bot.callbackQuery(/^vote:(\d+)$/, async (ctx) => {
    const user = await kit.identity(ctx.from);
    const projectId = Number(ctx.match[1]);
    const [project] = await sql<
      { slug: string; chat_id: number; voted: boolean }[]
    >`
      SELECT slug, chat_id, EXISTS (SELECT 1 FROM votes WHERE project_id = ${projectId} AND user_id = ${user.id}) AS voted
      FROM projects WHERE id = ${projectId}`;
    if (!project) return ctx.answerCallbackQuery({ text: "Project not found" });
    const result = await setVote(sql, projectId, user.id, !project.voted);
    if (result === "own_project")
      return ctx.answerCallbackQuery({
        text: "You can't vote for your own project 🙂",
      });
    await ctx.answerCallbackQuery({
      text: project.voted ? "Vote removed" : "Counted 👍",
    });
    const person = await getPerson(sql, project.chat_id, user.id);
    if (person)
      await projectScreen(
        ctx,
        { user, chatId: project.chat_id, person },
        project.slug,
        true,
      );
  });

  bot.callbackQuery(
    /^pe:(\d+):(status|tagline|stack|links|delete)$/,
    async (ctx) => {
      const user = await kit.identity(ctx.from);
      const projectId = Number(ctx.match[1]);
      if (
        !kit.isPrivate(ctx) ||
        !(await canEditProject(sql, projectId, user.id, kit.isOwner(user)))
      )
        return ctx.answerCallbackQuery({
          text: "Only the author can edit, in a DM with the bot",
        });
      await ctx.answerCallbackQuery();
      const [project] = await sql<
        {
          slug: string;
          chat_id: number;
          name: string;
          tagline: string | null;
          stack: string[];
        }[]
      >`
      SELECT slug, chat_id, name, tagline, stack FROM projects WHERE id = ${projectId}`;
      if (!project) return;
      const back = new InlineKeyboard().text("Cancel", `p:${project.slug}`);
      switch (ctx.match[2]) {
        case "status":
          return void (await kit.show(
            ctx,
            `📌 Status of <b>${escapeHtml(project.name)}</b>:`,
            grid(
              PROJECT_STATUSES.map((status, index) =>
                InlineKeyboard.text(
                  `${STATUS_EMOJI[status]} ${STATUS_LABELS[status]}`,
                  `ps:${projectId}:${index}`,
                ),
              ),
              2,
            )
              .row()
              .text("Cancel", `p:${project.slug}`),
            { edit: true },
          ));
        case "tagline":
          pending.set(ctx.from.id, {
            kind: "project_field",
            chatId: project.chat_id,
            projectId,
            field: "tagline",
          });
          return void (await kit.show(
            ctx,
            `📝 Describe <b>${escapeHtml(project.name)}</b> in one sentence.\nNow: ${project.tagline ? escapeHtml(project.tagline) : "none"}`,
            back,
            { edit: true },
          ));
        case "stack":
          pending.set(ctx.from.id, {
            kind: "project_field",
            chatId: project.chat_id,
            projectId,
            field: "stack",
          });
          return void (await kit.show(
            ctx,
            `🧰 Stack, comma-separated.\nNow: ${project.stack.length ? escapeHtml(project.stack.join(", ")) : "none"}`,
            back,
            { edit: true },
          ));
        case "links":
          pending.set(ctx.from.id, {
            kind: "project_field",
            chatId: project.chat_id,
            projectId,
            field: "links",
          });
          return void (await kit.show(
            ctx,
            "🔗 Send the links — repository and/or website (both in one message is fine).",
            back,
            { edit: true },
          ));
        case "delete":
          return void (await kit.show(
            ctx,
            `Remove <b>${escapeHtml(project.name)}</b> from the catalog?`,
            new InlineKeyboard()
              .text("Yes, remove", `pdel:${projectId}`)
              .text("Cancel", `p:${project.slug}`),
            { edit: true },
          ));
      }
    },
  );

  bot.callbackQuery(/^ps:(\d+):(\d)$/, async (ctx) => {
    const user = await kit.identity(ctx.from);
    const projectId = Number(ctx.match[1]);
    const status = PROJECT_STATUSES[Number(ctx.match[2])];
    if (
      !status ||
      !(await canEditProject(sql, projectId, user.id, kit.isOwner(user)))
    )
      return ctx.answerCallbackQuery();
    const [project] = await sql<
      { name: string; slug: string; chat_id: number }[]
    >`SELECT name, slug, chat_id FROM projects WHERE id = ${projectId}`;
    if (!project) return ctx.answerCallbackQuery();
    await upsertProject(sql, {
      chatId: project.chat_id,
      name: project.name,
      status,
      authorIds: [],
      sourceMsgIds: [],
      activityAt: new Date(),
      source: kit.isOwner(user) ? "admin" : "user",
      actorUserId: user.id,
    });
    await ctx.answerCallbackQuery({ text: `Status: ${STATUS_LABELS[status]}` });
    const person = await getPerson(sql, project.chat_id, user.id);
    if (person)
      await projectScreen(
        ctx,
        { user, chatId: project.chat_id, person },
        project.slug,
        true,
      );
  });

  bot.callbackQuery(/^pdel:(\d+)$/, async (ctx) => {
    const user = await kit.identity(ctx.from);
    const projectId = Number(ctx.match[1]);
    if (!(await canEditProject(sql, projectId, user.id, kit.isOwner(user))))
      return ctx.answerCallbackQuery({ text: "Only the author can remove it" });
    await hideProject(sql, projectId, user.id);
    await ctx.answerCallbackQuery({ text: "Removed" });
    await kit.show(
      ctx,
      "Project removed from the catalog.",
      new InlineKeyboard().text("← Projects", "pl:top:0"),
      { edit: true },
    );
  });

  bot.command(
    "addproject",
    scoped(async (ctx, scope) => {
      const [rawUrl, ...rest] = commandArgs(ctx).split(/\s+/);
      const normalized = rawUrl ? normalizeUrl(rawUrl) : null;
      if (!rawUrl || !normalized) {
        if (kit.isPrivate(ctx))
          return void (await kit.show(
            ctx,
            "Use a link: /addproject https://github.com/you/repo Short description — or step by step:",
            new InlineKeyboard().text("➕ New project", "np:start"),
          ));
        return void (await kit.show(
          ctx,
          "Format: /addproject https://github.com/you/repo Short description",
        ));
      }
      const user = scope.user;
      const isRepo = ["github.com", "gitlab.com", "codeberg.org"].includes(
        normalized.domain,
      );
      const pathParts = new URL(rawUrl).pathname.split("/").filter(Boolean);
      const name =
        isRepo && pathParts[1]
          ? pathParts[1]
          : (normalized.domain.split(".")[0] ?? normalized.domain);
      const { project, created } = await upsertProject(sql, {
        chatId: scope.chatId,
        name,
        tagline: rest.join(" ") || null,
        links: isRepo ? { repo: rawUrl } : { site: rawUrl },
        authorIds: [user.id],
        sourceMsgIds:
          ctx.msg && !kit.isPrivate(ctx) ? [ctx.msg.message_id] : [],
        activityAt: new Date(),
        source: "user",
        actorUserId: user.id,
      });
      await kit.show(
        ctx,
        `${created ? "Added" : "Updated"} project <b>${escapeHtml(project.name)}</b> ✅`,
        new InlineKeyboard().text("Open card", `p:${project.slug}`),
      );
    }),
  );

  // ---------- Chronicle ----------

  async function chronicleScreen(
    ctx: BotContext,
    scope: Scope,
    days: number,
    page: number,
    edit: boolean,
  ) {
    const entries = await topChronicle(
      sql,
      scope.chatId,
      new Date(Date.now() - days * 86_400_000),
      topLimitFor(days),
    );
    const totalPages = Math.max(
      1,
      Math.ceil(entries.length / CHRONICLE_PER_PAGE),
    );
    const current = Math.min(page, totalPages - 1);
    const slice = entries.slice(
      current * CHRONICLE_PER_PAGE,
      (current + 1) * CHRONICLE_PER_PAGE,
    );
    const keyboard = new InlineKeyboard();
    for (const [value, label] of [
      [1, "24 h"],
      [3, "3 days"],
      [7, "Week"],
      [30, "Month"],
    ] as const) {
      keyboard.text(value === days ? `· ${label} ·` : label, `ch:${value}:0`);
    }
    keyboard.row();
    for (const button of pager(`ch:${days}`, current, totalPages))
      keyboard.add(button);
    const body = slice.length
      ? slice
          .map(
            (entry) =>
              `<i>${formatDate(entry.period_to, config.DISPLAY_TIMEZONE)}</i>\n${chronicleLine(entry, scope.chatId)}`,
          )
          .join("\n\n")
      : `The chronicle is empty for this period. The chronicler goes through new messages every ${config.EXTRACTION_INTERVAL_HOURS} h.`;
    await kit.show(ctx, `📜 <b>Chat highlights</b>\n\n${body}`, keyboard, {
      edit,
    });
  }

  const chronicle = scoped(chronicleScreen);
  bot.command(["chronicle", "today", "week"], async (ctx) => {
    const command = ctx.msg?.text?.split(/[\s@]/)[0]?.slice(1);
    const parsed = Number.parseInt(commandArgs(ctx), 10);
    const days =
      Number.isFinite(parsed) && parsed > 0
        ? Math.min(parsed, 60)
        : command === "week"
          ? 7
          : command === "today"
            ? 1
            : 3;
    await chronicle(ctx, days, 0, false);
  });
  bot.callbackQuery(/^ch:(\d+):(\d+)$/, (ctx) =>
    chronicle(ctx, Number(ctx.match[1]), Number(ctx.match[2]), true),
  );

  // ---------- Links ----------

  async function linksScreen(
    ctx: BotContext,
    scope: Scope,
    page: number,
    edit: boolean,
  ) {
    const [total] = await sql<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM links WHERE chat_id = ${scope.chatId} AND NOT from_forward`;
    const totalPages = Math.max(
      1,
      Math.ceil((total?.count ?? 0) / LINKS_PER_PAGE),
    );
    const current = Math.min(page, totalPages - 1);
    const links = await sql<
      {
        url: string;
        context: string | null;
        last_msg_id: number | null;
        display_name: string | null;
        share_count: number;
      }[]
    >`
      SELECT l.url, l.context, l.last_msg_id, u.display_name, l.share_count
      FROM links l LEFT JOIN users u ON u.id = l.first_user_id
      WHERE l.chat_id = ${scope.chatId} AND NOT l.from_forward
      ORDER BY l.first_seen_at DESC
      LIMIT ${LINKS_PER_PAGE} OFFSET ${current * LINKS_PER_PAGE}`;
    const lines = links.map((link) => {
      const where = link.last_msg_id
        ? ` <a href="${messageLink(scope.chatId, link.last_msg_id)}">💬</a>`
        : "";
      const who = link.display_name
        ? ` — ${escapeHtml(link.display_name)}`
        : "";
      const context = link.context
        ? `\n   <i>${escapeHtml(truncate(link.context, 90))}</i>`
        : "";
      return `• ${escapeHtml(truncate(link.url.replace(/^https?:\/\//, ""), 70))}${who}${link.share_count > 1 ? ` ×${link.share_count}` : ""}${where}${context}`;
    });
    const keyboard = new InlineKeyboard();
    for (const button of pager("ln", current, totalPages)) keyboard.add(button);
    await kit.show(
      ctx,
      [
        `🔗 <b>Links from the chat</b> (newest first)`,
        "",
        ...(lines.length ? lines : ["Nothing yet."]),
      ].join("\n"),
      keyboard,
      { edit },
    );
  }

  const links = scoped(linksScreen);
  bot.command("links", (ctx) => links(ctx, 0, false));
  bot.callbackQuery(/^ln:(\d+)$/, (ctx) =>
    links(ctx, Number(ctx.match[1]), true),
  );

  bot.callbackQuery("noop", (ctx) => ctx.answerCallbackQuery());

  return { personScreen, projectScreen, chronicleScreen };
}
