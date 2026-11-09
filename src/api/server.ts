import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Sql } from "../core/db.js";
import { FACT_KINDS, getFact, ownFacts, proposeFact, rejectFact, setFactHidden, visibleFacts } from "../core/facts.js";
import { canEditProject, getProjectBySlug, hideProject, listProjects, PROJECT_STATUSES, projectsOfUser, setVote, upsertProject } from "../core/projects.js";
import { topChronicle, topLimitFor } from "../core/chronicle.js";
import { messageLink, truncate } from "../core/text.js";
import { approvedChats, chatsOfUser, setCurrentChat, type Chat } from "../core/chats.js";
import { ensureMember, getPerson, peopleOfChat, resolveUser, setOptOut, setTagline, type Person, type User } from "../core/users.js";
import { validateInitData } from "./init-data.js";

export interface ApiDeps {
  sql: Sql;
  botToken: string;
  adminTgIds: number[];
  /** Asks Telegram whether the account is in the chat (cached by the caller). */
  isMember: (chatId: number, tgUserId: number) => Promise<boolean>;
  webDistDir: string;
  /** Local development: a request carrying this secret acts as `devLoginAs` without Telegram. */
  devLogin?: { token: string; loginAs: string };
}

type Env = { Variables: { user: User; chatId: number; person: Person } };

/** Accepts «c100123» (as in links and start params) or a plain chat id. */
export function parseChatParam(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const encoded = /^c(\d+)$/.exec(raw);
  if (encoded) return -Number(encoded[1]);
  return /^-?\d+$/.test(raw) ? Number(raw) : null;
}

const ManualFactSchema = z.object({
  kind: z.enum(FACT_KINDS),
  value: z.string().trim().min(1).max(160),
});

const ProjectPatchSchema = z.object({
  tagline: z.string().trim().max(200).nullable().optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  stack: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  repo: z.string().url().nullable().optional(),
  site: z.string().url().nullable().optional(),
});

const ProjectCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  tagline: z.string().trim().max(200).nullable().optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  repo: z.string().url().nullable().optional(),
  site: z.string().url().nullable().optional(),
  stack: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
});

function publicUser(user: Person) {
  return {
    id: user.id,
    display_name: user.display_name,
    username: user.username,
    tagline: user.opted_out ? null : user.tagline,
    opted_out: user.opted_out,
    last_message_at: user.last_message_at,
    first_seen_at: user.first_seen_at,
  };
}

export function createApi(deps: ApiDeps): Hono<Env> {
  const { sql } = deps;
  const app = new Hono<Env>();
  const isOwner = (user: User) => user.is_admin || (user.tg_id !== null && deps.adminTgIds.includes(user.tg_id));

  app.get("/healthz", async (c) => {
    await sql`SELECT 1`;
    return c.json({ ok: true });
  });

  const api = new Hono<Env>();

  api.use("*", async (c, next) => {
    const devToken = c.req.header("x-dev-login");
    if (deps.devLogin && devToken) {
      const expected = Buffer.from(deps.devLogin.token);
      const given = Buffer.from(devToken);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return c.json({ error: "unauthorized" }, 401);
      const loginAs = deps.devLogin.loginAs.replace(/^@/, "");
      const [devUser] = await sql<User[]>`
        SELECT u.* FROM users u
        WHERE EXISTS (SELECT 1 FROM members m JOIN chats ch ON ch.id = m.chat_id WHERE m.user_id = u.id AND ch.status = 'approved')
        ORDER BY (${loginAs} <> '' AND (lower(u.username) = lower(${loginAs}) OR lower(u.display_name) = lower(${loginAs}))) IS TRUE DESC, u.is_admin DESC, u.id
        LIMIT 1`;
      if (!devUser) return c.json({ error: "no_chats" }, 403);
      c.set("user", devUser);
      return next();
    }
    const header = c.req.header("authorization") ?? "";
    const raw = header.startsWith("tma ") ? header.slice(4) : "";
    const data = raw ? validateInitData(raw, deps.botToken) : null;
    if (!data) return c.json({ error: "unauthorized" }, 401);
    c.set("user", await resolveUser(sql, data.user, deps.adminTgIds));
    await next();
  });

  /** Approved chats of the person; silent members (never wrote) are confirmed with Telegram. */
  const chatsFor = async (c: Context<Env>): Promise<Chat[]> => {
    const user = c.get("user");
    const chats = await chatsOfUser(sql, user.id);
    if (chats.length > 0 || user.tg_id === null) return chats;
    for (const chat of await approvedChats(sql)) {
      if (await deps.isMember(chat.id, user.tg_id)) await ensureMember(sql, chat.id, user.id);
    }
    return chatsOfUser(sql, user.id);
  };

  api.get("/chats", async (c) => {
    const user = c.get("user");
    const chats = await chatsFor(c);
    const current = chats.find((chat) => chat.id === user.current_chat_id) ?? (chats.length === 1 ? chats[0] : undefined);
    return c.json({ chats: chats.map((chat) => ({ id: chat.id, key: `c${Math.abs(chat.id)}`, title: chat.title })), current: current ? `c${Math.abs(current.id)}` : null });
  });

  // Everything below is about one chat: x-chat-id header, else the chat picked last.
  api.use("*", async (c, next) => {
    if (c.req.path.endsWith("/api/chats")) return next();
    const user = c.get("user");
    const chats = await chatsFor(c);
    const wanted = parseChatParam(c.req.header("x-chat-id"));
    const chat = wanted !== null ? chats.find((candidate) => candidate.id === wanted) : (chats.find((candidate) => candidate.id === user.current_chat_id) ?? (chats.length === 1 ? chats[0] : undefined));
    if (!chat) {
      const notMember = chats.length === 0 || wanted !== null;
      return c.json({ error: notMember ? "not_a_member" : "choose_chat" }, notMember ? 403 : 409);
    }
    // A live member check: someone who left keeps no access even if the leave update was missed.
    if (user.tg_id !== null && !(deps.devLogin && c.req.header("x-dev-login")) && !(await deps.isMember(chat.id, user.tg_id))) return c.json({ error: "not_a_member" }, 403);
    const person = await getPerson(sql, chat.id, user.id);
    if (!person) return c.json({ error: "not_a_member" }, 403);
    if (user.current_chat_id !== chat.id) await setCurrentChat(sql, user.id, chat.id);
    c.set("chatId", chat.id);
    c.set("person", person);
    await next();
  });

  const linkFor = (c: Context<Env>, msgId: number) => messageLink(c.get("chatId"), msgId);
  /** Projects are addressed by id; make sure one from another chat is never touched. */
  const projectInChat = async (c: Context<Env>, projectId: number) => {
    const [row] = await sql<{ id: number }[]>`SELECT id FROM projects WHERE id = ${projectId} AND chat_id = ${c.get("chatId")}`;
    return Boolean(row);
  };

  const withSources =
    (c: Context<Env>) =>
    <T extends { source_msg_ids: number[] }>(item: T) => ({
      ...item,
      sources: item.source_msg_ids.slice(0, 3).map((id) => ({ id, url: linkFor(c, id) })),
    });

  api.get("/me", async (c) => {
    const user = c.get("user");
    const person = c.get("person");
    const chatId = c.get("chatId");
    const [facts, projects] = await Promise.all([ownFacts(sql, chatId, user.id), projectsOfUser(sql, chatId, user.id)]);
    return c.json({
      user: { ...publicUser(person), tagline: person.tagline, tagline_manual: person.tagline_manual, is_admin: isOwner(user) },
      facts: facts.map(withSources(c)),
      projects,
    });
  });

  api.patch("/me", async (c) => {
    const user = c.get("user");
    const body = z.object({ tagline: z.string().trim().max(90).nullable().optional(), opted_out: z.boolean().optional() }).safeParse(await c.req.json());
    if (!body.success) return c.json({ error: "bad_request" }, 400);
    const person = c.get("person");
    const chatId = c.get("chatId");
    if (body.data.opted_out !== undefined && body.data.opted_out !== person.opted_out) await setOptOut(sql, user.id, body.data.opted_out, chatId);
    if (body.data.tagline !== undefined) await setTagline(sql, chatId, user.id, body.data.tagline || null, user.id);
    return c.json({ ok: true });
  });

  api.post("/me/facts", async (c) => {
    const user = c.get("user");
    const body = ManualFactSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: "bad_request" }, 400);
    if (c.get("person").opted_out) return c.json({ error: "opted_out" }, 409);
    const result = await proposeFact(sql, { chatId: c.get("chatId"), userId: user.id, kind: body.data.kind, value: body.data.value, confidence: 1, sourceMsgIds: [], source: "user", actorUserId: user.id });
    return c.json({ result });
  });

  const factAction = (action: "reject" | "hide" | "restore") => async (c: Context<Env>) => {
    const user = c.get("user");
    const fact = await getFact(sql, Number(c.req.param("id")));
    if (!fact || fact.chat_id !== c.get("chatId")) return c.json({ error: "not_found" }, 404);
    if (fact.user_id !== user.id && !isOwner(user)) return c.json({ error: "forbidden" }, 403);
    const source = fact.user_id === user.id ? "user" : "admin";
    const ok = action === "reject" ? await rejectFact(sql, fact.id, user.id, source) : await setFactHidden(sql, fact.id, action === "hide", user.id, source);
    return c.json({ ok });
  };
  api.post("/facts/:id/reject", factAction("reject"));
  api.post("/facts/:id/hide", factAction("hide"));
  api.post("/facts/:id/restore", factAction("restore"));

  api.get("/people", async (c) => {
    const chatId = c.get("chatId");
    const [people, extras] = await Promise.all([
      peopleOfChat(sql, chatId),
      sql<{ user_id: number; top_facts: string[] | null; project_count: number }[]>`
        SELECT m.user_id,
               (SELECT array_agg(value ORDER BY confidence DESC) FROM (
                  SELECT f.value, f.confidence FROM facts f
                  WHERE f.chat_id = ${chatId} AND f.user_id = m.user_id AND f.kind IN ('role', 'stack', 'expertise')
                    AND (f.status = 'manual' OR (f.status = 'auto' AND f.confidence >= 0.6))
                  ORDER BY f.status = 'manual' DESC, f.confidence DESC LIMIT 4) t) AS top_facts,
               (SELECT count(*)::int FROM project_members pm JOIN projects p ON p.id = pm.project_id
                WHERE pm.user_id = m.user_id AND p.chat_id = ${chatId} AND NOT p.hidden) AS project_count
        FROM members m WHERE m.chat_id = ${chatId} AND m.left_at IS NULL`,
    ]);
    const extraOf = new Map(extras.map((row) => [row.user_id, row]));
    return c.json({
      people: people.map((person) => ({
        ...publicUser(person),
        linked: person.tg_id !== null,
        top_facts: person.opted_out ? [] : extraOf.get(person.id)?.top_facts ?? [],
        project_count: extraOf.get(person.id)?.project_count ?? 0,
      })),
    });
  });

  api.get("/people/:id", async (c) => {
    const chatId = c.get("chatId");
    const person = await getPerson(sql, chatId, Number(c.req.param("id")));
    if (!person) return c.json({ error: "not_found" }, 404);
    const [facts, projects, stats] = await Promise.all([
      person.opted_out ? Promise.resolve([]) : visibleFacts(sql, chatId, person.id),
      projectsOfUser(sql, chatId, person.id),
      sql<{ messages_30d: number }[]>`
        SELECT count(*)::int AS messages_30d FROM messages
        WHERE chat_id = ${chatId} AND user_id = ${person.id} AND sent_at > now() - interval '30 days'`,
    ]);
    const viewer = c.get("user");
    return c.json({
      person: publicUser(person),
      facts: facts.map(withSources(c)),
      projects,
      messages_30d: stats[0]?.messages_30d ?? 0,
      can_edit: viewer.id === person.id || isOwner(viewer),
    });
  });

  api.get("/projects", async (c) => {
    const sort = c.req.query("sort");
    const projects = await listProjects(sql, c.get("chatId"), {
      sort: sort === "new" || sort === "alive" ? sort : "top",
      viewerUserId: c.get("user").id,
    });
    return c.json({ projects });
  });

  api.get("/projects/:slug", async (c) => {
    const user = c.get("user");
    const chatId = c.get("chatId");
    const project = await getProjectBySlug(sql, chatId, c.req.param("slug"), user.id);
    if (!project) return c.json({ error: "not_found" }, 404);
    // Only messages the chronicler linked to this project by meaning — never a plain word match.
    const discussions = await sql<{ msg_id: number; sent_at: Date; text: string; display_name: string | null }[]>`
      SELECT m.msg_id, m.sent_at, m.text, u.display_name
      FROM messages m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.chat_id = ${chatId}
        AND (m.msg_id = ANY(${project.source_msg_ids})
             OR m.msg_id IN (SELECT unnest(source_msg_ids) FROM project_signals WHERE project_id = ${project.id} AND NOT hidden))
      ORDER BY m.sent_at DESC
      LIMIT 6`;
    const history = await sql<{ id: number; title: string; summary: string; kind: string; importance: number; period_to: Date; msg_ids: number[] }[]>`
      SELECT id, title, summary, kind, importance, period_to, msg_ids FROM chronicle
      WHERE project_id = ${project.id}
      ORDER BY period_to DESC
      LIMIT 10`;
    return c.json({
      project,
      can_edit: await canEditProject(sql, project.id, user.id, isOwner(user)),
      first_seen_url: project.first_seen_msg_id ? linkFor(c, project.first_seen_msg_id) : null,
      discussions: discussions.map((row) => ({ ...row, text: truncate(row.text, 220), url: linkFor(c, row.msg_id) })),
      history: history.map((entry) => ({ ...entry, url: entry.msg_ids[0] ? linkFor(c, entry.msg_ids[0]) : null })),
    });
  });

  api.post("/projects", async (c) => {
    const user = c.get("user");
    const body = ProjectCreateSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: "bad_request" }, 400);
    const { project } = await upsertProject(sql, {
      chatId: c.get("chatId"),
      name: body.data.name,
      tagline: body.data.tagline ?? null,
      status: body.data.status,
      stack: body.data.stack,
      links: { repo: body.data.repo ?? null, site: body.data.site ?? null },
      authorIds: [user.id],
      sourceMsgIds: [],
      activityAt: new Date(),
      source: "user",
      actorUserId: user.id,
    });
    return c.json({ slug: project.slug });
  });

  api.patch("/projects/:id", async (c) => {
    const user = c.get("user");
    const projectId = Number(c.req.param("id"));
    if (!(await projectInChat(c, projectId))) return c.json({ error: "not_found" }, 404);
    if (!(await canEditProject(sql, projectId, user.id, isOwner(user)))) return c.json({ error: "forbidden" }, 403);
    const body = ProjectPatchSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: "bad_request" }, 400);
    const [current] = await sql<{ name: string; links: { repo?: string | null; site?: string | null } }[]>`SELECT name, links FROM projects WHERE id = ${projectId}`;
    if (!current) return c.json({ error: "not_found" }, 404);
    const linksChanged = body.data.repo !== undefined || body.data.site !== undefined;
    await upsertProject(sql, {
      chatId: c.get("chatId"),
      name: current.name,
      tagline: body.data.tagline,
      status: body.data.status,
      stack: body.data.stack,
      links: linksChanged ? { repo: body.data.repo ?? current.links.repo ?? null, site: body.data.site ?? current.links.site ?? null } : undefined,
      authorIds: [],
      sourceMsgIds: [],
      source: isOwner(user) ? "admin" : "user",
      actorUserId: user.id,
    });
    if (body.data.stack) await sql`UPDATE projects SET stack = ${body.data.stack} WHERE id = ${projectId}`;
    return c.json({ ok: true });
  });

  api.delete("/projects/:id", async (c) => {
    const user = c.get("user");
    const projectId = Number(c.req.param("id"));
    if (!(await projectInChat(c, projectId))) return c.json({ error: "not_found" }, 404);
    if (!(await canEditProject(sql, projectId, user.id, isOwner(user)))) return c.json({ error: "forbidden" }, 403);
    await hideProject(sql, projectId, user.id);
    return c.json({ ok: true });
  });

  api.post("/projects/:id/vote", async (c) => {
    const body = z.object({ voted: z.boolean() }).safeParse(await c.req.json());
    if (!body.success) return c.json({ error: "bad_request" }, 400);
    const projectId = Number(c.req.param("id"));
    if (!(await projectInChat(c, projectId))) return c.json({ error: "not_found" }, 404);
    const result = await setVote(sql, projectId, c.get("user").id, body.data.voted);
    return result === "ok" ? c.json({ ok: true }) : c.json({ error: result }, 409);
  });

  api.get("/chronicle", async (c) => {
    const days = Math.min(Math.max(Number(c.req.query("days") ?? 7), 1), 60);
    const entries = await topChronicle(sql, c.get("chatId"), new Date(Date.now() - days * 86_400_000), topLimitFor(days));
    return c.json({ entries: entries.map((entry) => ({ ...entry, url: entry.msg_ids[0] ? linkFor(c, entry.msg_ids[0]) : null })) });
  });

  api.get("/links", async (c) => {
    const links = await sql<{ url: string; domain: string; context: string | null; share_count: number; last_msg_id: number | null; display_name: string | null; first_seen_at: Date }[]>`
      SELECT l.url, l.domain, l.context, l.share_count, l.last_msg_id, u.display_name, l.first_seen_at
      FROM links l LEFT JOIN users u ON u.id = l.first_user_id
      WHERE l.chat_id = ${c.get("chatId")} AND NOT l.from_forward
      ORDER BY l.first_seen_at DESC
      LIMIT 200`;
    return c.json({ links: links.map((link) => ({ ...link, where: link.last_msg_id ? linkFor(c, link.last_msg_id) : null })) });
  });

  app.route("/api", api);

  const distRoot = path.resolve(deps.webDistDir);
  app.use("/app/*", serveStatic({ root: path.relative(process.cwd(), distRoot), rewriteRequestPath: (requestPath) => requestPath.replace(/^\/app/, "") }));
  const toApp = (requestUrl: string) => `/app/${new URL(requestUrl).search}`;
  app.get("/", (c) => c.redirect(toApp(c.req.url)));
  app.get("/app", (c) => c.redirect(toApp(c.req.url)));
  app.get("/app/*", async (c) => {
    try {
      return c.html(await readFile(path.join(distRoot, "index.html"), "utf8"));
    } catch {
      return c.text("Mini App ещё не собрана: npm run build:web", 503);
    }
  });

  return app;
}
