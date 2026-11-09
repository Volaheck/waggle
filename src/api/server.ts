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
import { findUserByRef, getUser, resolveUser, setOptOut, setTagline, type User } from "../core/users.js";
import { validateInitData } from "./init-data.js";

export interface ApiDeps {
  sql: Sql;
  botToken: string;
  chatId: number;
  adminTgIds: number[];
  isMember: (tgUserId: number) => Promise<boolean>;
  webDistDir: string;
  /** Local development: a request carrying this secret acts as `devLoginAs` without Telegram. */
  devLogin?: { token: string; loginAs: string };
}

type Env = { Variables: { user: User } };

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

function publicUser(user: User) {
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
  const { sql, chatId } = deps;
  const app = new Hono<Env>();
  const linkFor = (msgId: number) => messageLink(chatId, msgId);

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
      const [fallback] = await sql<User[]>`SELECT * FROM users WHERE left_at IS NULL ORDER BY is_admin DESC, id LIMIT 1`;
      const devUser = (deps.devLogin.loginAs ? await findUserByRef(sql, deps.devLogin.loginAs) : undefined) ?? fallback ?? (await resolveUser(sql, { id: 1, first_name: "Dev" }, []));
      c.set("user", devUser);
      return next();
    }
    const header = c.req.header("authorization") ?? "";
    const raw = header.startsWith("tma ") ? header.slice(4) : "";
    const data = raw ? validateInitData(raw, deps.botToken) : null;
    if (!data) return c.json({ error: "unauthorized" }, 401);
    if (!(await deps.isMember(data.user.id))) return c.json({ error: "not_a_member" }, 403);
    c.set("user", await resolveUser(sql, data.user, deps.adminTgIds));
    await next();
  });

  const withSources = <T extends { source_msg_ids: number[] }>(item: T) => ({
    ...item,
    sources: item.source_msg_ids.slice(0, 3).map((id) => ({ id, url: linkFor(id) })),
  });

  api.get("/me", async (c) => {
    const user = c.get("user");
    const [facts, projects] = await Promise.all([ownFacts(sql, user.id), projectsOfUser(sql, user.id)]);
    return c.json({ user: { ...publicUser(user), tagline: user.tagline, tagline_manual: user.tagline_manual, is_admin: user.is_admin }, facts: facts.map(withSources), projects });
  });

  api.patch("/me", async (c) => {
    const user = c.get("user");
    const body = z.object({ tagline: z.string().trim().max(90).nullable().optional(), opted_out: z.boolean().optional() }).safeParse(await c.req.json());
    if (!body.success) return c.json({ error: "bad_request" }, 400);
    if (body.data.opted_out !== undefined && body.data.opted_out !== user.opted_out) await setOptOut(sql, user.id, body.data.opted_out);
    if (body.data.tagline !== undefined) await setTagline(sql, user.id, body.data.tagline || null, user.id);
    return c.json({ ok: true });
  });

  api.post("/me/facts", async (c) => {
    const user = c.get("user");
    const body = ManualFactSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: "bad_request" }, 400);
    if (user.opted_out) return c.json({ error: "opted_out" }, 409);
    const result = await proposeFact(sql, { userId: user.id, kind: body.data.kind, value: body.data.value, confidence: 1, sourceMsgIds: [], source: "user", actorUserId: user.id });
    return c.json({ result });
  });

  const factAction = (action: "reject" | "hide" | "restore") => async (c: Context<Env>) => {
    const user = c.get("user");
    const fact = await getFact(sql, Number(c.req.param("id")));
    if (!fact) return c.json({ error: "not_found" }, 404);
    if (fact.user_id !== user.id && !user.is_admin) return c.json({ error: "forbidden" }, 403);
    const source = fact.user_id === user.id ? "user" : "admin";
    const ok = action === "reject" ? await rejectFact(sql, fact.id, user.id, source) : await setFactHidden(sql, fact.id, action === "hide", user.id, source);
    return c.json({ ok });
  };
  api.post("/facts/:id/reject", factAction("reject"));
  api.post("/facts/:id/hide", factAction("hide"));
  api.post("/facts/:id/restore", factAction("restore"));

  api.get("/people", async (c) => {
    const people = await sql<(User & { top_facts: string[] | null; project_count: number })[]>`
      SELECT u.*,
             (SELECT array_agg(value ORDER BY confidence DESC) FROM (
                SELECT f.value, f.confidence FROM facts f
                WHERE f.user_id = u.id AND f.kind IN ('role', 'stack', 'expertise')
                  AND (f.status = 'manual' OR (f.status = 'auto' AND f.confidence >= 0.6))
                ORDER BY f.status = 'manual' DESC, f.confidence DESC LIMIT 4) t) AS top_facts,
             (SELECT count(*)::int FROM project_members pm JOIN projects p ON p.id = pm.project_id WHERE pm.user_id = u.id AND NOT p.hidden) AS project_count
      FROM users u
      WHERE u.left_at IS NULL
      ORDER BY u.last_message_at DESC NULLS LAST, u.display_name`;
    return c.json({
      people: people.map((person) => ({
        ...publicUser(person),
        linked: person.tg_id !== null,
        top_facts: person.opted_out ? [] : person.top_facts ?? [],
        project_count: person.project_count,
      })),
    });
  });

  api.get("/people/:id", async (c) => {
    const person = await getUser(sql, Number(c.req.param("id")));
    if (!person) return c.json({ error: "not_found" }, 404);
    const [facts, projects, stats] = await Promise.all([
      person.opted_out ? Promise.resolve([]) : visibleFacts(sql, person.id),
      projectsOfUser(sql, person.id),
      sql<{ messages_30d: number }[]>`SELECT count(*)::int AS messages_30d FROM messages WHERE user_id = ${person.id} AND sent_at > now() - interval '30 days'`,
    ]);
    const viewer = c.get("user");
    return c.json({
      person: publicUser(person),
      facts: facts.map(withSources),
      projects,
      messages_30d: stats[0]?.messages_30d ?? 0,
      can_edit: viewer.id === person.id || viewer.is_admin,
    });
  });

  api.get("/projects", async (c) => {
    const sort = c.req.query("sort");
    const projects = await listProjects(sql, {
      sort: sort === "new" || sort === "alive" ? sort : "top",
      viewerUserId: c.get("user").id,
    });
    return c.json({ projects });
  });

  api.get("/projects/:slug", async (c) => {
    const user = c.get("user");
    const project = await getProjectBySlug(sql, c.req.param("slug"), user.id);
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
      can_edit: await canEditProject(sql, project.id, user.id, user.is_admin),
      first_seen_url: project.first_seen_msg_id ? linkFor(project.first_seen_msg_id) : null,
      discussions: discussions.map((row) => ({ ...row, text: truncate(row.text, 220), url: linkFor(row.msg_id) })),
      history: history.map((entry) => ({ ...entry, url: entry.msg_ids[0] ? linkFor(entry.msg_ids[0]) : null })),
    });
  });

  api.post("/projects", async (c) => {
    const user = c.get("user");
    const body = ProjectCreateSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: "bad_request" }, 400);
    const { project } = await upsertProject(sql, {
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
    if (!(await canEditProject(sql, projectId, user.id, user.is_admin))) return c.json({ error: "forbidden" }, 403);
    const body = ProjectPatchSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: "bad_request" }, 400);
    const [current] = await sql<{ name: string; links: { repo?: string | null; site?: string | null } }[]>`SELECT name, links FROM projects WHERE id = ${projectId}`;
    if (!current) return c.json({ error: "not_found" }, 404);
    const linksChanged = body.data.repo !== undefined || body.data.site !== undefined;
    await upsertProject(sql, {
      name: current.name,
      tagline: body.data.tagline,
      status: body.data.status,
      stack: body.data.stack,
      links: linksChanged ? { repo: body.data.repo ?? current.links.repo ?? null, site: body.data.site ?? current.links.site ?? null } : undefined,
      authorIds: [],
      sourceMsgIds: [],
      source: user.is_admin ? "admin" : "user",
      actorUserId: user.id,
    });
    if (body.data.stack) await sql`UPDATE projects SET stack = ${body.data.stack} WHERE id = ${projectId}`;
    return c.json({ ok: true });
  });

  api.delete("/projects/:id", async (c) => {
    const user = c.get("user");
    const projectId = Number(c.req.param("id"));
    if (!(await canEditProject(sql, projectId, user.id, user.is_admin))) return c.json({ error: "forbidden" }, 403);
    await hideProject(sql, projectId, user.id);
    return c.json({ ok: true });
  });

  api.post("/projects/:id/vote", async (c) => {
    const body = z.object({ voted: z.boolean() }).safeParse(await c.req.json());
    if (!body.success) return c.json({ error: "bad_request" }, 400);
    const result = await setVote(sql, Number(c.req.param("id")), c.get("user").id, body.data.voted);
    return result === "ok" ? c.json({ ok: true }) : c.json({ error: result }, 409);
  });

  api.get("/chronicle", async (c) => {
    const days = Math.min(Math.max(Number(c.req.query("days") ?? 7), 1), 60);
    const entries = await topChronicle(sql, new Date(Date.now() - days * 86_400_000), topLimitFor(days));
    return c.json({ entries: entries.map((entry) => ({ ...entry, url: entry.msg_ids[0] ? linkFor(entry.msg_ids[0]) : null })) });
  });

  api.get("/links", async (c) => {
    const links = await sql<{ url: string; domain: string; context: string | null; share_count: number; last_msg_id: number | null; display_name: string | null; first_seen_at: Date }[]>`
      SELECT l.url, l.domain, l.context, l.share_count, l.last_msg_id, u.display_name, l.first_seen_at
      FROM links l LEFT JOIN users u ON u.id = l.first_user_id
      WHERE NOT l.from_forward
      ORDER BY l.first_seen_at DESC
      LIMIT 200`;
    return c.json({ links: links.map((link) => ({ ...link, where: link.last_msg_id ? linkFor(link.last_msg_id) : null })) });
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
