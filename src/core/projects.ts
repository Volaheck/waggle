import type { Queryable, Sql } from "./db.js";
import { isNearDuplicate } from "./facts.js";
import { normalizeUrl, slugify } from "./text.js";

export const PROJECT_STATUSES = ["идея", "в работе", "запущен", "на паузе", "заброшен"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export interface ProjectLinks {
  repo?: string | null;
  site?: string | null;
  other?: string[];
}

export interface Project {
  id: number;
  chat_id: number;
  slug: string;
  name: string;
  tagline: string | null;
  status: ProjectStatus;
  stack: string[];
  links: ProjectLinks;
  confidence: number;
  hidden: boolean;
  manual_fields: string[];
  first_seen_msg_id: number | null;
  last_activity_at: Date | null;
  source_msg_ids: number[];
  created_at: Date;
}

export interface ProjectSignalPreview {
  kind: string;
  note: string;
  msg_id: number | null;
  happened_at: string;
}

export interface ProjectListItem extends Project {
  authors: { id: number; display_name: string; username: string | null; role: string | null }[];
  votes: number;
  signals_count: number;
  recent_signals: ProjectSignalPreview[];
  score: number;
  voted_by_me: boolean;
}

export type ProjectSort = "top" | "new" | "alive";

/**
 * Internal weights. Users only see that the chronicler (the LLM) decides —
 * it judges each signal's impact; we just add votes and fade old signals.
 */
const RATING = {
  vote: 5,
  kindWeight: { usage: 3, contribution: 3, praise: 2, milestone: 2, critique: 1.5, interest: 1 },
  decayDays: 45,
  windowDays: 180,
  abandonedMultiplier: 0.3,
} as const;

export async function listProjects(sql: Sql, chatId: number, options: { sort?: ProjectSort; viewerUserId?: number; limit?: number } = {}): Promise<ProjectListItem[]> {
  const sort = options.sort ?? "top";
  const viewer = options.viewerUserId ?? 0;
  const limit = options.limit ?? 200;
  const weights = RATING.kindWeight;
  const orderBy =
    sort === "new"
      ? sql`p.created_at DESC`
      : sort === "alive"
        ? sql`greatest(p.last_activity_at, s.last_signal, p.created_at) DESC NULLS LAST`
        : sql`score DESC, greatest(p.last_activity_at, s.last_signal, p.created_at) DESC NULLS LAST`;
  return sql<ProjectListItem[]>`
    WITH s AS (
      SELECT ps.project_id,
             count(*)::int AS signals_count,
             max(ps.happened_at) AS last_signal,
             sum(ps.impact * CASE ps.kind
                   WHEN 'usage' THEN ${weights.usage}::numeric WHEN 'contribution' THEN ${weights.contribution}::numeric
                   WHEN 'praise' THEN ${weights.praise}::numeric WHEN 'milestone' THEN ${weights.milestone}::numeric
                   WHEN 'critique' THEN ${weights.critique}::numeric ELSE ${weights.interest}::numeric END
                 * exp(-extract(epoch FROM now() - ps.happened_at) / (86400.0 * ${RATING.decayDays}::numeric))) AS signal_points
      FROM project_signals ps
      WHERE NOT ps.hidden AND ps.happened_at > now() - ${`${RATING.windowDays} days`}::interval
      GROUP BY ps.project_id
    ),
    v AS (SELECT project_id, count(*)::int AS votes FROM votes GROUP BY project_id)
    SELECT p.*,
           coalesce(v.votes, 0) AS votes,
           coalesce(s.signals_count, 0) AS signals_count,
           round((coalesce(v.votes, 0) * ${RATING.vote}::numeric + coalesce(s.signal_points, 0)::numeric)
                 * CASE WHEN p.status = 'заброшен' THEN ${RATING.abandonedMultiplier}::numeric ELSE 1 END)::int AS score,
           coalesce((SELECT json_agg(json_build_object('id', u.id, 'display_name', u.display_name, 'username', u.username, 'role', pm.role) ORDER BY pm.role IS NULL, u.display_name)
                     FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = p.id), '[]') AS authors,
           coalesce((SELECT json_agg(json_build_object('kind', r.kind, 'note', r.note, 'msg_id', r.source_msg_ids[1], 'happened_at', r.happened_at))
                     FROM (SELECT * FROM project_signals WHERE project_id = p.id AND NOT hidden ORDER BY happened_at DESC LIMIT 5) r), '[]') AS recent_signals,
           EXISTS (SELECT 1 FROM votes vv WHERE vv.project_id = p.id AND vv.user_id = ${viewer}) AS voted_by_me
    FROM projects p
    LEFT JOIN s ON s.project_id = p.id
    LEFT JOIN v ON v.project_id = p.id
    WHERE p.chat_id = ${chatId} AND NOT p.hidden
    ORDER BY ${orderBy}
    LIMIT ${limit}`;
}

export const RATING_EXPLANATION = [
  "<b>Как считается рейтинг</b>",
  "",
  "Рейтинг ведёт летописец — нейронка, которая раз в несколько часов читает чат. Она замечает, что реально происходит с проектами: отзывы участников, кто чем пользуется, кто помогает, как проект развивается, — и сама решает, насколько это весомо.",
  "",
  "Голоса 👍 участников тоже учитываются. Свежее весит больше старого, а накрутить рейтинг повторными упоминаниями не получится.",
].join("\n");

export async function getProjectBySlug(sql: Sql, chatId: number, slug: string, viewerUserId?: number): Promise<ProjectListItem | undefined> {
  const all = await listProjects(sql, chatId, { viewerUserId });
  return all.find((project) => project.slug === slug.toLowerCase());
}

export async function findProject(sql: Sql, chatId: number, query: string): Promise<Project | undefined> {
  const needle = query.trim();
  const [project] = await sql<Project[]>`
    SELECT * FROM projects
    WHERE chat_id = ${chatId} AND NOT hidden AND (slug = ${slugify(needle)} OR lower(name) = lower(${needle}) OR name ILIKE '%' || ${needle} || '%')
    ORDER BY (lower(name) = lower(${needle})) DESC, length(name)
    LIMIT 1`;
  return project;
}

export async function projectsOfUser(sql: Sql, chatId: number, userId: number): Promise<Project[]> {
  return sql<Project[]>`
    SELECT p.* FROM projects p JOIN project_members pm ON pm.project_id = p.id
    WHERE p.chat_id = ${chatId} AND pm.user_id = ${userId} AND NOT p.hidden
    ORDER BY p.last_activity_at DESC NULLS LAST`;
}

export interface ProjectUpsert {
  chatId: number;
  slug?: string;
  name: string;
  tagline?: string | null;
  status?: ProjectStatus | null;
  stack?: string[];
  links?: ProjectLinks;
  authorIds: number[];
  sourceMsgIds: number[];
  firstSeenMsgId?: number | null;
  activityAt?: Date | null;
  confidence?: number;
  source: "llm" | "user" | "admin" | "seed";
  actorUserId?: number;
}

function sameUrl(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  return normalizeUrl(a)?.norm === normalizeUrl(b)?.norm;
}

/**
 * The same product must not appear twice: match by slug, name, a shared link,
 * or a name that means the same thing with at least one author in common.
 */
async function findExisting(sql: Sql, upsert: ProjectUpsert, slug: string): Promise<Project | undefined> {
  const candidates = await sql<(Project & { author_ids: number[] })[]>`
    SELECT p.*, coalesce(array_agg(pm.user_id) FILTER (WHERE pm.user_id IS NOT NULL), '{}') AS author_ids
    FROM projects p LEFT JOIN project_members pm ON pm.project_id = p.id
    WHERE p.chat_id = ${upsert.chatId}
    GROUP BY p.id`;
  const name = upsert.name.toLowerCase();
  return (
    candidates.find((project) => project.slug === slug || project.name.toLowerCase() === name) ??
    candidates.find((project) => sameUrl(project.links.repo, upsert.links?.repo) || sameUrl(project.links.site, upsert.links?.site)) ??
    candidates.find(
      (project) => isNearDuplicate(project.name, upsert.name) && project.author_ids.some((id) => upsert.authorIds.includes(id)),
    )
  );
}

/**
 * Creates or enriches a project. Fields a human edited (manual_fields) are never
 * overwritten by the extractor; for the rest the newest non-empty value wins.
 */
export async function upsertProject(sql: Sql, upsert: ProjectUpsert): Promise<{ project: Project; created: boolean }> {
  const slug = slugify(upsert.slug || upsert.name);
  const existing = await findExisting(sql, upsert, slug);

  return sql.begin(async (tx) => {
    let project: Project;
    let created = false;
    if (!existing) {
      const uniqueSlug = await freeSlug(tx, upsert.chatId, slug);
      const [inserted] = await tx<Project[]>`
        INSERT INTO projects (chat_id, slug, name, tagline, status, stack, links, confidence, first_seen_msg_id, last_activity_at, source_msg_ids)
        VALUES (${upsert.chatId}, ${uniqueSlug}, ${upsert.name}, ${upsert.tagline ?? null}, ${upsert.status ?? "в работе"}, ${upsert.stack ?? []},
                ${tx.json(cleanLinks(upsert.links))}, ${upsert.confidence ?? 1}, ${upsert.firstSeenMsgId ?? upsert.sourceMsgIds[0] ?? null},
                ${upsert.activityAt ?? null}, ${upsert.sourceMsgIds})
        RETURNING *`;
      project = inserted!;
      created = true;
    } else {
      const locked = upsert.source === "llm" ? new Set(existing.manual_fields) : new Set<string>();
      const pick = <T>(field: string, next: T | null | undefined, current: T): T =>
        locked.has(field) || next === undefined || next === null || (Array.isArray(next) && next.length === 0) ? current : next;
      const mergedLinks = locked.has("links") ? existing.links : { ...existing.links, ...cleanLinks(upsert.links) };
      const mergedStack = locked.has("stack") ? existing.stack : [...new Set([...existing.stack, ...(upsert.stack ?? [])])];
      const manualFields =
        upsert.source === "user" || upsert.source === "admin"
          ? [...new Set([...existing.manual_fields, ...changedFields(upsert)])]
          : existing.manual_fields;
      const [updated] = await tx<Project[]>`
        UPDATE projects SET
          tagline = ${pick("tagline", upsert.tagline, existing.tagline)},
          status = ${pick("status", upsert.status, existing.status)},
          stack = ${mergedStack},
          links = ${tx.json(mergedLinks)},
          confidence = greatest(confidence, ${upsert.confidence ?? 0}),
          manual_fields = ${manualFields},
          last_activity_at = greatest(last_activity_at, ${upsert.activityAt ?? null}),
          source_msg_ids = coalesce((SELECT array_agg(DISTINCT x) FROM unnest(source_msg_ids || ${upsert.sourceMsgIds}::bigint[]) AS x), '{}'),
          updated_at = now()
        WHERE id = ${existing.id}
        RETURNING *`;
      project = updated!;
    }

    for (const authorId of upsert.authorIds) {
      await tx`INSERT INTO project_members (project_id, user_id) VALUES (${project.id}, ${authorId}) ON CONFLICT DO NOTHING`;
    }
    await tx`
      INSERT INTO change_log (entity, entity_id, op, after, source, actor_user_id, source_msg_ids)
      VALUES ('project', ${project.id}, ${created ? "create" : "update"},
              ${tx.json({ name: upsert.name, tagline: upsert.tagline ?? null, status: upsert.status ?? null, links: cleanLinks(upsert.links) })},
              ${upsert.source}, ${upsert.actorUserId ?? null}, ${upsert.sourceMsgIds})`;
    return { project, created };
  });
}

function changedFields(upsert: ProjectUpsert): string[] {
  const fields: string[] = [];
  if (upsert.tagline !== undefined) fields.push("tagline");
  if (upsert.status) fields.push("status");
  if (upsert.stack) fields.push("stack");
  if (upsert.links) fields.push("links");
  return fields;
}

function cleanLinks(links: ProjectLinks | undefined): ProjectLinks {
  if (!links) return {};
  const result: ProjectLinks = {};
  if (links.repo) result.repo = links.repo;
  if (links.site) result.site = links.site;
  if (links.other?.length) result.other = links.other;
  return result;
}

async function freeSlug(sql: Queryable, chatId: number, base: string): Promise<string> {
  const taken = new Set(
    (await sql<{ slug: string }[]>`SELECT slug FROM projects WHERE chat_id = ${chatId} AND (slug = ${base} OR slug LIKE ${`${base}-%`})`).map((row) => row.slug),
  );
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    if (!taken.has(`${base}-${suffix}`)) return `${base}-${suffix}`;
  }
}

export async function setVote(sql: Sql, projectId: number, userId: number, voted: boolean): Promise<"ok" | "own_project"> {
  const [own] = await sql`SELECT 1 FROM project_members WHERE project_id = ${projectId} AND user_id = ${userId}`;
  if (own) return "own_project";
  if (voted) {
    await sql`INSERT INTO votes (project_id, user_id) VALUES (${projectId}, ${userId}) ON CONFLICT DO NOTHING`;
  } else {
    await sql`DELETE FROM votes WHERE project_id = ${projectId} AND user_id = ${userId}`;
  }
  return "ok";
}

export async function canEditProject(sql: Sql, projectId: number, userId: number, isAdmin: boolean): Promise<boolean> {
  if (isAdmin) return true;
  const [member] = await sql`SELECT 1 FROM project_members WHERE project_id = ${projectId} AND user_id = ${userId}`;
  return Boolean(member);
}

export async function hideProject(sql: Sql, projectId: number, actorUserId: number): Promise<void> {
  await sql`UPDATE projects SET hidden = true, updated_at = now() WHERE id = ${projectId}`;
  await sql`INSERT INTO change_log (entity, entity_id, op, source, actor_user_id) VALUES ('project', ${projectId}, 'hide', 'user', ${actorUserId})`;
}

export async function setMemberRole(sql: Sql, projectId: number, userId: number, role: string | null): Promise<void> {
  await sql`
    INSERT INTO project_members (project_id, user_id, role) VALUES (${projectId}, ${userId}, ${role})
    ON CONFLICT (project_id, user_id) DO UPDATE SET role = excluded.role`;
}

/** Folds duplicate catalog entries into one: authors, votes, signals and links move over, the rest is hidden. */
export async function mergeProjects(sql: Sql, chatId: number, intoSlug: string, fromSlugs: string[]): Promise<number> {
  return sql.begin(async (tx) => {
    const [into] = await tx<Project[]>`SELECT * FROM projects WHERE chat_id = ${chatId} AND slug = ${intoSlug} AND NOT hidden FOR UPDATE`;
    if (!into) return 0;
    const from = await tx<Project[]>`SELECT * FROM projects WHERE chat_id = ${chatId} AND slug = ANY(${fromSlugs}) AND slug <> ${intoSlug} AND NOT hidden FOR UPDATE`;
    for (const project of from) {
      await tx`
        INSERT INTO project_members (project_id, user_id, role)
        SELECT ${into.id}, user_id, role FROM project_members WHERE project_id = ${project.id}
        ON CONFLICT (project_id, user_id) DO UPDATE SET role = coalesce(project_members.role, excluded.role)`;
      await tx`
        INSERT INTO votes (project_id, user_id, created_at)
        SELECT ${into.id}, user_id, created_at FROM votes WHERE project_id = ${project.id}
        ON CONFLICT DO NOTHING`;
      await tx`UPDATE project_signals SET project_id = ${into.id} WHERE project_id = ${project.id}`;
      await tx`UPDATE chronicle SET project_id = ${into.id} WHERE project_id = ${project.id}`;
      const links = { ...project.links, ...into.links, other: [...new Set([...(into.links.other ?? []), ...(project.links.other ?? [])])] };
      await tx`
        UPDATE projects SET
          links = ${tx.json(links)},
          stack = (SELECT coalesce(array_agg(DISTINCT x), '{}') FROM unnest(stack || ${project.stack}::text[]) AS x),
          source_msg_ids = (SELECT coalesce(array_agg(DISTINCT x), '{}') FROM unnest(source_msg_ids || ${project.source_msg_ids}::bigint[]) AS x),
          first_seen_msg_id = least(first_seen_msg_id, ${project.first_seen_msg_id}),
          last_activity_at = greatest(last_activity_at, ${project.last_activity_at}),
          updated_at = now()
        WHERE id = ${into.id}`;
      await tx`UPDATE projects SET hidden = true, updated_at = now() WHERE id = ${project.id}`;
      await tx`
        INSERT INTO change_log (entity, entity_id, op, before, source)
        VALUES ('project', ${into.id}, 'merge', ${tx.json({ merged: project.slug })}, 'llm')`;
    }
    return from.length;
  });
}
