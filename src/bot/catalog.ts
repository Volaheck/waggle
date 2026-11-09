import { InlineKeyboard } from "grammy";
import { memberAliases } from "../core/aliases.js";
import { visibleFacts, whoKnows } from "../core/facts.js";
import {
  addUserProject,
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
  updateProject,
  type ProjectSort,
} from "../core/projects.js";
import { topChronicle, topLimitFor } from "../core/chronicle.js";
import {
  escapeHtml,
  isRepoHost,
  projectNameFromUrl,
  safeHttpUrl,
  truncate,
} from "../core/text.js";
import {
  findPersonByRef,
  getPerson,
  peopleOfChat,
  SERVICE_TG_IDS,
  type Person,
  type User,
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
  encodeChat,
  grid,
  pager,
  realReply,
  type BotContext,
  type BotKit,
  type Scope,
} from "./kit.js";

const PEOPLE_PER_PAGE = 8;
const PROJECTS_PER_PAGE = 8;
const CHRONICLE_PER_PAGE = 5;

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
    const [facts, projects, aliases] = await Promise.all([
      person.opted_out
        ? Promise.resolve([])
        : visibleFacts(sql, scope.chatId, person.id),
      projectsOfUser(sql, scope.chatId, person.id),
      memberAliases(sql, scope.chatId, person.id),
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
      keyboard.row().text("✏️ Edit my card", `me:${encodeChat(scope.chatId)}:home`);
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
      personCard(person, facts, projects, { compact: !kit.isPrivate(ctx), aliases }),
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
      const replied = realReply(ctx.msg);
      let targetId: number | undefined;
      if (ref) targetId = (await findPersonByRef(sql, scope.chatId, ref))?.id;
      else if (replied) {
        const author = replied.from;
        if (!author || author.is_bot || replied.sender_chat || replied.is_automatic_forward || SERVICE_TG_IDS.includes(author.id))
          return void (await kit.show(ctx, "That was posted by a bot or on behalf of a channel — I keep cards only for people."));
        // Replying to someone does not make them a member: Telegram says whether they are still in the chat.
        targetId = (await kit.currentMember(scope.chatId, author))?.id;
        if (!targetId)
          return void (await kit.show(ctx, `${escapeHtml(author.first_name)} isn't in this chat anymore.`));
      } else targetId = scope.user.id;
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
    if (kit.isPrivate(ctx)) keyboard.text("➕ Add yours", `np:${encodeChat(scope.chatId)}:start`);
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

  interface ButtonProject {
    user: User;
    person: Person | undefined;
    project: { id: number; slug: string; chat_id: number; name: string; tagline: string | null; stack: string[] };
  }

  /**
   * A project addressed by id from a button, which can carry any id. It is acted on only in an approved chat
   * the presser is in right now (a group button only for that group's own projects); for editing the presser
   * must also be an author, or an owner, who moderates without being a member. Every refusal looks the same.
   */
  async function projectFromButton(ctx: BotContext, projectId: number, purpose: "vote" | "edit"): Promise<ButtonProject | undefined> {
    if (!ctx.from) return undefined;
    const user = await kit.identity(ctx.from);
    const [project] = await sql<ButtonProject["project"][]>`
      SELECT p.id, p.slug, p.chat_id, p.name, p.tagline, p.stack FROM projects p JOIN chats c ON c.id = p.chat_id
      WHERE p.id = ${projectId} AND NOT p.hidden AND c.status = 'approved'`;
    if (!project || (!kit.isPrivate(ctx) && ctx.chat?.id !== project.chat_id)) return undefined;
    const moderator = purpose === "edit" && kit.isOwner(user);
    const person = moderator ? await getPerson(sql, project.chat_id, user.id) : await kit.currentMember(project.chat_id, ctx.from);
    if (!moderator && !person) return undefined;
    if (purpose === "edit" && !(await canEditProject(sql, project.id, user.id, moderator))) return undefined;
    return { user, person, project };
  }

  bot.callbackQuery(/^vote:(\d+)$/, async (ctx) => {
    const found = await projectFromButton(ctx, Number(ctx.match[1]), "vote");
    if (!found?.person) return ctx.answerCallbackQuery({ text: "Project not found" });
    const { user, person, project } = found;
    const [vote] = await sql<{ voted: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM votes WHERE project_id = ${project.id} AND user_id = ${user.id}) AS voted`;
    const voted = Boolean(vote?.voted);
    const result = await setVote(sql, project.id, user.id, !voted);
    if (result === "own_project")
      return ctx.answerCallbackQuery({
        text: "You can't vote for your own project 🙂",
      });
    await ctx.answerCallbackQuery({
      text: voted ? "Vote removed" : "Counted 👍",
    });
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
      const found = kit.isPrivate(ctx) ? await projectFromButton(ctx, Number(ctx.match[1]), "edit") : undefined;
      if (!found)
        return ctx.answerCallbackQuery({
          text: "Only the author can edit, in a DM with the bot",
        });
      await ctx.answerCallbackQuery();
      const { project } = found;
      const projectId = project.id;
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
    const status = PROJECT_STATUSES[Number(ctx.match[2])];
    const found = status && kit.isPrivate(ctx) ? await projectFromButton(ctx, Number(ctx.match[1]), "edit") : undefined;
    if (!found || !status) return ctx.answerCallbackQuery();
    const { user, project } = found;
    await updateProject(sql, {
      chatId: project.chat_id,
      projectId: project.id,
      status,
      source: (await canEditProject(sql, project.id, user.id, false)) ? "user" : "admin",
      actorUserId: user.id,
      activityAt: new Date(),
    });
    await ctx.answerCallbackQuery({ text: `Status: ${STATUS_LABELS[status]}` });
    if (found.person)
      await projectScreen(
        ctx,
        { user, chatId: project.chat_id, person: found.person },
        project.slug,
        true,
      );
  });

  bot.callbackQuery(/^pdel:(\d+)$/, async (ctx) => {
    const found = kit.isPrivate(ctx) ? await projectFromButton(ctx, Number(ctx.match[1]), "edit") : undefined;
    if (!found) return ctx.answerCallbackQuery({ text: "Only the author can remove it" });
    await hideProject(sql, found.project.id, found.user.id);
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
      const url = safeHttpUrl(rawUrl);
      const name = url ? projectNameFromUrl(url) : null;
      if (!url || !name) {
        if (kit.isPrivate(ctx))
          return void (await kit.show(
            ctx,
            "Use a link: /addproject https://github.com/you/repo Short description — or step by step:",
            new InlineKeyboard().text("➕ New project", `np:${encodeChat(scope.chatId)}:start`),
          ));
        return void (await kit.show(
          ctx,
          "Format: /addproject https://github.com/you/repo Short description",
        ));
      }
      const description = rest.join(" ").trim().slice(0, 200);
      const result = await addUserProject(sql, {
        chatId: scope.chatId,
        name,
        tagline: description || undefined,
        links: isRepoHost(new URL(url).hostname) ? { repo: url } : { site: url },
        sourceMsgIds:
          ctx.msg && !kit.isPrivate(ctx) ? [ctx.msg.message_id] : [],
        actorUserId: scope.user.id,
      });
      const project = `<b>${escapeHtml(result.project.name)}</b>`;
      const open = new InlineKeyboard().text("Open card", `p:${result.project.slug}`);
      if (result.outcome === "exists") {
        const [row] = await sql<{ authors: string | null }[]>`
          SELECT string_agg(u.display_name, ', ' ORDER BY u.display_name) AS authors
          FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ${result.project.id}`;
        return void (await kit.show(
          ctx,
          `There's already ${project} in this chat's catalog${row?.authors ? ` (by ${escapeHtml(row.authors)})` : ""}, so I left it as it is. If yours is a different project, add it under its own name with ➕ New project in a DM with me.`,
          open,
        ));
      }
      const text = {
        created: `Added project ${project} ✅`,
        own: result.changed ? `Updated project ${project} ✅` : `${project} is already among your projects — nothing to change.`,
        restored: `Project ${project} is back in the catalog ✅`,
      }[result.outcome];
      await kit.show(ctx, text, open);
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

  bot.callbackQuery("noop", (ctx) => ctx.answerCallbackQuery());

  return { personScreen, projectScreen, chronicleScreen };
}
