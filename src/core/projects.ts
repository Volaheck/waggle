import type { Queryable, Sql } from "./db.js";
import { isNearDuplicate } from "./facts.js";
import { normalizeUrl, safeHttpUrl, slugify } from "./text.js";

/** Stored as is and used verbatim by the chronicler, whose schemas accept exactly these codes. */
export const PROJECT_STATUSES = ["idea", "in_progress", "launched", "paused", "abandoned"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const STATUS_LABELS: Record<ProjectStatus, string> = {
  idea: "idea",
  in_progress: "in progress",
  launched: "launched",
  paused: "paused",
  abandoned: "abandoned",
};

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

/** An abandoned project's score is multiplied by this; the bot may say so, unlike the other weights. */
export const ABANDONED_MULTIPLIER = RATING.abandonedMultiplier;

/**
 * What one signal adds to the score today: its impact by the kind's weight, fading with its age in whole days (the
 * window is applied apart). Scores change at midnight, not every few hours, so the chat's memory in an answer's prompt
 * stays the same from one answer to the next and the prompt cache can keep it.
 */
function signalPoints(sql: Sql, signal: string) {
  const weights = RATING.kindWeight;
  const row = sql.unsafe(signal);
  return sql`${row}.impact * CASE ${row}.kind
      WHEN 'usage' THEN ${weights.usage}::numeric WHEN 'contribution' THEN ${weights.contribution}::numeric
      WHEN 'praise' THEN ${weights.praise}::numeric WHEN 'milestone' THEN ${weights.milestone}::numeric
      WHEN 'critique' THEN ${weights.critique}::numeric ELSE ${weights.interest}::numeric END
    * exp(-greatest(0, (now() AT TIME ZONE 'UTC')::date - (${row}.happened_at AT TIME ZONE 'UTC')::date) / ${RATING.decayDays}::numeric)`;
}

export async function listProjects(sql: Sql, chatId: number, options: { sort?: ProjectSort; viewerUserId?: number; limit?: number } = {}): Promise<ProjectListItem[]> {
  const sort = options.sort ?? "top";
  const viewer = options.viewerUserId ?? 0;
  const limit = options.limit ?? 200;
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
             sum(${signalPoints(sql, "ps")}) AS signal_points
      FROM project_signals ps
      WHERE NOT ps.hidden AND ps.happened_at > now() - ${`${RATING.windowDays} days`}::interval
      GROUP BY ps.project_id
    ),
    v AS (SELECT project_id, count(*)::int AS votes FROM votes GROUP BY project_id)
    SELECT p.*,
           coalesce(v.votes, 0) AS votes,
           coalesce(s.signals_count, 0) AS signals_count,
           round((coalesce(v.votes, 0) * ${RATING.vote}::numeric + coalesce(s.signal_points, 0)::numeric)
                 * CASE WHEN p.status = 'abandoned' THEN ${RATING.abandonedMultiplier}::numeric ELSE 1 END)::int AS score,
           coalesce((SELECT json_agg(json_build_object('id', u.id, 'display_name', u.display_name, 'username', u.username, 'role', pm.role) ORDER BY pm.role IS NULL, u.display_name, u.id)
                     FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = p.id), '[]') AS authors,
           coalesce((SELECT json_agg(json_build_object('kind', r.kind, 'note', r.note, 'msg_id', r.source_msg_ids[1], 'happened_at', r.happened_at))
                     FROM (SELECT * FROM project_signals WHERE project_id = p.id AND NOT hidden ORDER BY happened_at DESC LIMIT 5) r), '[]') AS recent_signals,
           EXISTS (SELECT 1 FROM votes vv WHERE vv.project_id = p.id AND vv.user_id = ${viewer}) AS voted_by_me
    FROM projects p
    LEFT JOIN s ON s.project_id = p.id
    LEFT JOIN v ON v.project_id = p.id
    WHERE p.chat_id = ${chatId} AND NOT p.hidden
    ORDER BY ${orderBy}, p.id
    LIMIT ${limit}`;
}

export interface RatedSignal {
  kind: string;
  impact: number;
  note: string;
  happened_at: Date;
  /** What it adds to the score today; 0 once it is older than the rating window. */
  points: number;
}

export interface RatingBreakdown {
  /** When each vote was cast; who cast it is never part of this. */
  votes: Date[];
  /** Every shown signal of all time, newest first. */
  signals: RatedSignal[];
}

export async function ratingBreakdown(sql: Sql, projectIds: number[]): Promise<Map<number, RatingBreakdown>> {
  const breakdown = new Map<number, RatingBreakdown>(projectIds.map((id) => [id, { votes: [], signals: [] }]));
  if (projectIds.length === 0) return breakdown;
  const [votes, signals] = await Promise.all([
    sql<{ project_id: number; created_at: Date }[]>`SELECT project_id, created_at FROM votes WHERE project_id = ANY(${projectIds}) ORDER BY created_at`,
    sql<(RatedSignal & { project_id: number })[]>`
      SELECT ps.project_id, ps.kind, ps.impact, ps.note, ps.happened_at,
             CASE WHEN ps.happened_at > now() - ${`${RATING.windowDays} days`}::interval THEN (${signalPoints(sql, "ps")})::float8 ELSE 0 END AS points
      FROM project_signals ps
      WHERE ps.project_id = ANY(${projectIds}) AND NOT ps.hidden
      ORDER BY ps.happened_at DESC`,
  ]);
  for (const vote of votes) breakdown.get(vote.project_id)?.votes.push(vote.created_at);
  for (const { project_id: projectId, ...signal } of signals) breakdown.get(projectId)?.signals.push(signal);
  return breakdown;
}

export interface FormerName {
  project_id: number;
  name: string;
  at: Date;
  /** A duplicate entry folded into the project, rather than a rename. */
  merged: boolean;
}

/** Names the chat's projects had before: renames, and the duplicate entries folded into them. Oldest first. */
export async function formerNames(sql: Sql, chatId: number): Promise<FormerName[]> {
  return sql<FormerName[]>`
    SELECT project_id, name, at, merged FROM (
      SELECT l.id, l.entity_id AS project_id, l.before->>'name' AS name, l.at, false AS merged
      FROM change_log l JOIN projects p ON p.id = l.entity_id
      WHERE l.entity = 'project' AND l.op = 'rename' AND p.chat_id = ${chatId} AND l.before->>'name' IS NOT NULL
      UNION ALL
      SELECT l.id, (l.after->>'into')::int, folded.name, l.at, true
      FROM change_log l JOIN projects folded ON folded.id = l.entity_id
      WHERE l.entity = 'project' AND l.op = 'merged_into' AND folded.chat_id = ${chatId}
    ) AS history
    ORDER BY id`;
}

export const RATING_EXPLANATION = [
  "<b>How the rating works</b>",
  "",
  "The rating is kept by the chronicler, an AI that reads the chat every few hours. It notices what is really happening with projects: feedback from members, who uses what, who helps out, how a project is moving along — and decides for itself how much that counts.",
  "",
  "Members' 👍 votes count too. Recent activity weighs more than old, and repeated mentions won't inflate the rating.",
].join("\n");

export async function getProjectBySlug(sql: Sql, chatId: number, slug: string, viewerUserId?: number): Promise<ProjectListItem | undefined> {
  const all = await listProjects(sql, chatId, { viewerUserId });
  const wanted = slug.toLowerCase();
  const direct = all.find((project) => project.slug === wanted);
  if (direct) return direct;
  // Old links and buttons keep working after a rename or a merge: follow the project to where it lives now.
  const moved = (await projectForSlug(sql, chatId, wanted)) ?? (await renamedFrom(sql, chatId, wanted));
  return moved ? all.find((project) => project.id === moved.id) : undefined;
}

async function renamedFrom(sql: Queryable, chatId: number, oldSlug: string): Promise<Project | undefined> {
  const [project] = await sql<Project[]>`
    SELECT p.* FROM change_log l JOIN projects p ON p.id = l.entity_id
    WHERE l.entity = 'project' AND l.op = 'rename' AND l.before->>'slug' = ${oldSlug} AND p.chat_id = ${chatId} AND NOT p.hidden
    ORDER BY l.id DESC LIMIT 1`;
  return project;
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

export interface UpsertResult {
  project: Project;
  created: boolean;
  /** False when the call left the project as it was: no field took a new value and no author was added. */
  changed: boolean;
}

type Candidate = Project & { author_ids: number[] };

const EDITABLE_FIELDS = ["tagline", "status", "stack", "links"] as const;
type EditableField = (typeof EDITABLE_FIELDS)[number];
type EditableValues = Pick<Project, EditableField>;

/** Matching and creating projects of one chat happen one at a time, so two adds of one name cannot both insert. */
async function lockChatProjects(tx: Queryable, chatId: number): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtext('waggle:projects'), hashtext(${String(chatId)}))`;
}

async function chatCandidates(tx: Queryable, chatId: number): Promise<Candidate[]> {
  return tx<Candidate[]>`
    SELECT p.*, coalesce(array_agg(pm.user_id) FILTER (WHERE pm.user_id IS NOT NULL), '{}') AS author_ids
    FROM projects p LEFT JOIN project_members pm ON pm.project_id = p.id
    WHERE p.chat_id = ${chatId}
    GROUP BY p.id
    ORDER BY p.hidden, p.id`;
}

function sameUrl(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  return normalizeUrl(a)?.norm === normalizeUrl(b)?.norm;
}

function linkList(links: ProjectLinks | undefined): string[] {
  return [links?.repo, links?.site, ...(links?.other ?? [])].filter((link): link is string => Boolean(link));
}

function sharesLink(project: ProjectLinks, links: ProjectLinks): boolean {
  const own = new Set(linkList(project).map((link) => normalizeUrl(link)?.norm));
  return linkList(links).some((link) => {
    const norm = normalizeUrl(link)?.norm;
    return norm !== undefined && own.has(norm);
  });
}

/**
 * The same product must not appear twice: match by slug, name, a shared link,
 * or a name that means the same thing with at least one author in common.
 */
function findExisting(candidates: Candidate[], upsert: ProjectUpsert, slug: string): Candidate | undefined {
  const name = upsert.name.toLowerCase();
  return (
    candidates.find((project) => project.slug === slug || project.name.toLowerCase() === name) ??
    candidates.find((project) => sameUrl(project.links.repo, upsert.links?.repo) || sameUrl(project.links.site, upsert.links?.site)) ??
    candidates.find(
      (project) => isNearDuplicate(project.name, upsert.name) && project.author_ids.some((id) => upsert.authorIds.includes(id)),
    )
  );
}

/** A duplicate folded into another entry leads to it (through every later merge too); a project people deleted leads nowhere. */
async function mergeTarget(tx: Queryable, project: Project): Promise<Project | undefined> {
  let current = project;
  for (let hop = 0; hop < 5 && current.hidden; hop += 1) {
    const [direct] = await tx<Project[]>`
      SELECT p.* FROM change_log l JOIN projects p ON p.id = (l.after->>'into')::int
      WHERE l.entity = 'project' AND l.entity_id = ${current.id} AND l.op = 'merged_into' AND p.chat_id = ${current.chat_id}
      ORDER BY l.id DESC LIMIT 1`;
    // Merges recorded before 'merged_into' existed only name the folded slug on the surviving project.
    const [recorded] = direct
      ? []
      : await tx<Project[]>`
          SELECT p.* FROM change_log l JOIN projects p ON p.id = l.entity_id
          WHERE l.entity = 'project' AND l.op = 'merge' AND l.before->>'merged' = ${current.slug}
            AND p.chat_id = ${current.chat_id} AND p.id <> ${current.id}
          ORDER BY l.id DESC LIMIT 1`;
    const next = direct ?? recorded;
    if (!next) return undefined;
    current = next;
  }
  return current.hidden ? undefined : current;
}

/** The chat's shown project for a slug the chronicler wrote; a duplicate folded into another entry resolves to that entry. */
export async function projectForSlug(sql: Queryable, chatId: number, slug: string): Promise<Project | undefined> {
  const [project] = await sql<Project[]>`SELECT * FROM projects WHERE chat_id = ${chatId} AND slug = ${slugify(slug)}`;
  if (!project) return undefined;
  return project.hidden ? mergeTarget(sql, project) : project;
}

function withScheme(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(value) ? `https://${value}` : value;
}

function cleanLinks(links: ProjectLinks | undefined): ProjectLinks {
  if (!links) return {};
  const result: ProjectLinks = {};
  const repo = safeHttpUrl(withScheme(links.repo));
  const site = safeHttpUrl(withScheme(links.site));
  const other = [...new Set((links.other ?? []).map((link) => safeHttpUrl(withScheme(link))).filter((link): link is string => Boolean(link)))];
  if (repo) result.repo = repo;
  if (site) result.site = site;
  if (other.length) result.other = other;
  return result;
}

function sameValue(field: EditableField, a: EditableValues, b: EditableValues): boolean {
  if (field === "stack") return a.stack.length === b.stack.length && a.stack.every((item, index) => item === b.stack[index]);
  if (field === "links") {
    const others = (links: ProjectLinks) => JSON.stringify(links.other ?? []);
    return (a.links.repo ?? null) === (b.links.repo ?? null) && (a.links.site ?? null) === (b.links.site ?? null) && others(a.links) === others(b.links);
  }
  return a[field] === b[field];
}

function pickFields(values: EditableValues, fields: EditableField[]): Partial<EditableValues> {
  return Object.fromEntries(fields.map((field) => [field, values[field]]));
}

/** Fields that carry a real value, which a person filling them in means to keep. */
function filledFields(values: EditableValues, statusChosen: boolean): EditableField[] {
  return EDITABLE_FIELDS.filter((field) =>
    field === "tagline" ? Boolean(values.tagline) : field === "status" ? statusChosen : field === "stack" ? values.stack.length > 0 : linkList(values.links).length > 0,
  );
}

/** Members the chronicler may name as authors: someone who opted out is never made one, even if they opted out while it was answering. */
async function willingAuthors(tx: Queryable, chatId: number, userIds: number[]): Promise<number[]> {
  if (userIds.length === 0) return [];
  const rows = await tx<{ user_id: number }[]>`
    SELECT user_id FROM members WHERE chat_id = ${chatId} AND user_id = ANY(${userIds}) AND NOT opted_out`;
  return rows.map((row) => row.user_id);
}

async function addAuthors(tx: Queryable, projectId: number, userIds: number[]): Promise<number[]> {
  const added: number[] = [];
  for (const userId of new Set(userIds)) {
    const [row] = await tx<{ user_id: number }[]>`
      INSERT INTO project_members (project_id, user_id) VALUES (${projectId}, ${userId}) ON CONFLICT DO NOTHING RETURNING user_id`;
    if (row) added.push(row.user_id);
  }
  return added;
}

async function insertProject(
  tx: Queryable,
  values: { chatId: number; slug: string; name: string; tagline: string | null; status: ProjectStatus | null; stack: string[]; links: ProjectLinks; manualFields: EditableField[] },
  extra: { confidence: number; firstSeenMsgId: number | null; activityAt: Date | null; sourceMsgIds: number[]; source: ProjectUpsert["source"]; actorUserId: number | null },
): Promise<Project> {
  const uniqueSlug = await freeSlug(tx, values.chatId, values.slug);
  const [project] = await tx<Project[]>`
    INSERT INTO projects (chat_id, slug, name, tagline, status, stack, links, confidence, manual_fields, first_seen_msg_id, last_activity_at, source_msg_ids)
    VALUES (${values.chatId}, ${uniqueSlug}, ${values.name}, ${values.tagline}, ${values.status ?? "in_progress"}, ${values.stack}, ${tx.json(values.links)},
            ${extra.confidence}, ${values.manualFields}, ${extra.firstSeenMsgId}, ${extra.activityAt}, ${extra.sourceMsgIds})
    RETURNING *`;
  await tx`
    INSERT INTO change_log (entity, entity_id, op, after, source, actor_user_id, source_msg_ids)
    VALUES ('project', ${project!.id}, 'create',
            ${tx.json({ name: project!.name, slug: project!.slug, ...pickFields(project!, [...EDITABLE_FIELDS]) })},
            ${extra.source}, ${extra.actorUserId}, ${extra.sourceMsgIds})`;
  return project!;
}

/**
 * Creates or enriches a project from the chronicler or the seed. Fields a human edited (manual_fields)
 * are never overwritten by the extractor; for the rest the newest non-empty value wins.
 * A shown project always wins the match over a hidden one; a hidden match that was folded into another
 * entry leads to that entry, and one people deleted stays deleted.
 */
export async function upsertProject(sql: Sql, upsert: ProjectUpsert): Promise<UpsertResult> {
  const slug = slugify(upsert.slug || upsert.name);
  const byHand = upsert.source === "user" || upsert.source === "admin";
  const links = cleanLinks(upsert.links);

  return sql.begin(async (tx) => {
    await lockChatProjects(tx, upsert.chatId);
    const authorIds = upsert.source === "llm" ? await willingAuthors(tx, upsert.chatId, upsert.authorIds) : upsert.authorIds;
    const request = { ...upsert, authorIds };
    const candidates = await chatCandidates(tx, upsert.chatId);
    const shown = findExisting(candidates.filter((project) => !project.hidden), request, slug);
    const hidden = shown || byHand ? undefined : findExisting(candidates.filter((project) => project.hidden), request, slug);
    const existing = shown ?? (hidden ? ((await mergeTarget(tx, hidden)) ?? hidden) : undefined);

    if (!existing) {
      const values: EditableValues = { tagline: upsert.tagline ?? null, status: upsert.status ?? "in_progress", stack: [...new Set(upsert.stack ?? [])], links };
      const project = await insertProject(
        tx,
        { chatId: upsert.chatId, slug, name: upsert.name, ...values, status: upsert.status ?? null, manualFields: byHand ? filledFields(values, Boolean(upsert.status)) : [] },
        {
          confidence: upsert.confidence ?? 1,
          firstSeenMsgId: upsert.firstSeenMsgId ?? upsert.sourceMsgIds[0] ?? null,
          activityAt: upsert.activityAt ?? null,
          sourceMsgIds: upsert.sourceMsgIds,
          source: upsert.source,
          actorUserId: upsert.actorUserId ?? null,
        },
      );
      await addAuthors(tx, project.id, authorIds);
      return { project, created: true, changed: true };
    }

    const locked = new Set(upsert.source === "llm" ? existing.manual_fields : []);
    const next: EditableValues = {
      tagline: locked.has("tagline") || !upsert.tagline ? existing.tagline : upsert.tagline,
      status: locked.has("status") || !upsert.status ? existing.status : upsert.status,
      stack: locked.has("stack") ? existing.stack : [...new Set([...existing.stack, ...(upsert.stack ?? [])])],
      links: locked.has("links") ? existing.links : { ...existing.links, ...links },
    };
    const changedFields = EDITABLE_FIELDS.filter((field) => !sameValue(field, existing, next));
    const authorsAdded = await addAuthors(tx, existing.id, authorIds);
    const changed = changedFields.length > 0 || authorsAdded.length > 0;
    const [project] = await tx<Project[]>`
      UPDATE projects SET
        tagline = ${next.tagline},
        status = ${next.status},
        stack = ${next.stack},
        links = ${tx.json(next.links)},
        confidence = greatest(confidence, ${upsert.confidence ?? 0}),
        manual_fields = ${byHand ? [...new Set([...existing.manual_fields, ...changedFields])] : existing.manual_fields},
        last_activity_at = greatest(last_activity_at, ${upsert.activityAt ?? null}),
        source_msg_ids = coalesce((SELECT array_agg(DISTINCT x) FROM unnest(source_msg_ids || ${upsert.sourceMsgIds}::bigint[]) AS x), '{}'),
        updated_at = CASE WHEN ${changed} THEN now() ELSE updated_at END
      WHERE id = ${existing.id}
      RETURNING *`;
    if (changed) {
      await tx`
        INSERT INTO change_log (entity, entity_id, op, before, after, source, actor_user_id, source_msg_ids)
        VALUES ('project', ${existing.id}, 'update', ${tx.json(pickFields(existing, changedFields))},
                ${tx.json({ ...pickFields(next, changedFields), ...(authorsAdded.length ? { authors_added: authorsAdded } : {}) })},
                ${upsert.source}, ${upsert.actorUserId ?? null}, ${upsert.sourceMsgIds})`;
    }
    return { project: project!, created: false, changed };
  });
}

/** What a person sets on a project. Undefined leaves a field alone; null (or an empty text) clears it. */
export interface ProjectFields {
  tagline?: string | null;
  status?: ProjectStatus;
  stack?: string[];
  links?: { repo?: string | null; site?: string | null };
}

function withLinks(current: ProjectLinks, patch: { repo?: string | null; site?: string | null }): ProjectLinks {
  const result: ProjectLinks = { ...current };
  for (const key of ["repo", "site"] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null || !value.trim()) {
      delete result[key];
      continue;
    }
    const url = safeHttpUrl(value);
    if (url) result[key] = url;
  }
  return result;
}

/** Applies a person's edit to one project row, locks what changed against the chronicler and logs only what really changed. */
async function applyEdit(
  tx: Queryable,
  current: Project,
  fields: ProjectFields,
  who: { source: "user" | "admin"; actorUserId: number },
  options: { activityAt?: Date; restore?: boolean } = {},
): Promise<{ project: Project; changed: boolean }> {
  const next: EditableValues = {
    tagline: fields.tagline === undefined ? current.tagline : fields.tagline?.trim() || null,
    status: fields.status ?? current.status,
    stack: fields.stack === undefined ? current.stack : [...new Set(fields.stack.map((item) => item.trim()).filter(Boolean))],
    links: fields.links === undefined ? current.links : withLinks(current.links, fields.links),
  };
  const changedFields = EDITABLE_FIELDS.filter((field) => !sameValue(field, current, next));
  if (changedFields.length === 0 && !options.restore) return { project: current, changed: false };
  const [project] = await tx<Project[]>`
    UPDATE projects SET
      tagline = ${next.tagline},
      status = ${next.status},
      stack = ${next.stack},
      links = ${tx.json(next.links)},
      manual_fields = ${[...new Set([...current.manual_fields, ...changedFields])]},
      hidden = ${options.restore ? false : current.hidden},
      last_activity_at = greatest(last_activity_at, ${options.activityAt ?? null}),
      updated_at = now()
    WHERE id = ${current.id}
    RETURNING *`;
  await tx`
    INSERT INTO change_log (entity, entity_id, op, before, after, source, actor_user_id)
    VALUES ('project', ${current.id}, ${options.restore ? "restore" : "update"}, ${tx.json(pickFields(current, changedFields))},
            ${tx.json(pickFields(next, changedFields))}, ${who.source}, ${who.actorUserId})`;
  return { project: project!, changed: true };
}

/** An edit addressed by project id: it can only ever touch that row, in that chat. Deleted projects are not edited. */
export async function updateProject(
  sql: Sql,
  edit: ProjectFields & { chatId: number; projectId: number; source: "user" | "admin"; actorUserId: number; activityAt?: Date },
): Promise<{ project: Project; changed: boolean } | undefined> {
  return sql.begin(async (tx) => {
    const [current] = await tx<Project[]>`
      SELECT * FROM projects WHERE id = ${edit.projectId} AND chat_id = ${edit.chatId} AND NOT hidden FOR UPDATE`;
    if (!current) return undefined;
    return applyEdit(tx, current, edit, edit, { activityAt: edit.activityAt });
  });
}

export type RenameOutcome = "renamed" | "unchanged" | "exists" | "not_found" | "locked";

/**
 * Renames a project and moves its slug to the new name. Another visible project of the chat with the
 * same name or slug blocks it. The old slug is kept in change_log, so old links still find the project.
 * A name a person set by hand is final for the chronicler ("locked").
 */
export async function renameProject(
  sql: Sql,
  input: { chatId: number; projectId: number; name: string; source: "user" | "admin" | "llm"; actorUserId: number | null },
): Promise<{ outcome: RenameOutcome; project?: Project; clash?: string }> {
  const name = input.name.trim().replace(/\s+/g, " ").slice(0, 80);
  return sql.begin(async (tx) => {
    await lockChatProjects(tx, input.chatId);
    const [current] = await tx<Project[]>`
      SELECT * FROM projects WHERE id = ${input.projectId} AND chat_id = ${input.chatId} AND NOT hidden FOR UPDATE`;
    if (!current) return { outcome: "not_found" };
    if (!name || current.name === name) return { outcome: "unchanged", project: current };
    if (input.source === "llm" && current.manual_fields.includes("name")) return { outcome: "locked", project: current };
    const base = slugify(name);
    const [clash] = await tx<{ slug: string }[]>`
      SELECT slug FROM projects
      WHERE chat_id = ${input.chatId} AND id <> ${current.id} AND NOT hidden AND (lower(name) = lower(${name}) OR slug = ${base})
      LIMIT 1`;
    if (clash) return { outcome: "exists", project: current, clash: clash.slug };
    const slug = base === current.slug ? base : await freeSlug(tx, input.chatId, base);
    const manual = input.source === "llm" ? current.manual_fields : [...new Set([...current.manual_fields, "name"])];
    const [project] = await tx<Project[]>`
      UPDATE projects SET name = ${name}, slug = ${slug}, manual_fields = ${manual}, updated_at = now() WHERE id = ${current.id} RETURNING *`;
    await tx`
      INSERT INTO change_log (entity, entity_id, op, before, after, source, actor_user_id)
      VALUES ('project', ${current.id}, 'rename', ${tx.json({ name: current.name, slug: current.slug })},
              ${tx.json({ name, slug })}, ${input.source}, ${input.actorUserId})`;
    return { outcome: "renamed", project: project! };
  });
}

export interface UserProjectInput extends ProjectFields {
  chatId: number;
  name: string;
  actorUserId: number;
  sourceMsgIds?: number[];
}

/**
 * - created: a new project, authored by the person;
 * - own: they already author a project with this name, slug or link, and the given values were applied to it;
 * - restored: their own deleted project with this name came back;
 * - exists: someone else's project has this name, slug or link, and nothing was changed.
 */
export type UserProjectOutcome = "created" | "own" | "restored" | "exists";

/**
 * A member adds a project by hand. It never takes over another member's entry: only the person's own projects
 * are matched for an update, and deleted projects of others are ignored (the new one gets a free slug).
 */
export async function addUserProject(sql: Sql, input: UserProjectInput): Promise<{ outcome: UserProjectOutcome; project: Project; changed: boolean }> {
  const name = input.name.trim();
  const slug = slugify(name);
  const links = cleanLinks(input.links);
  const fields: ProjectFields = {
    tagline: input.tagline?.trim() || undefined,
    status: input.status,
    stack: input.stack?.length ? input.stack : undefined,
    links: { repo: links.repo, site: links.site },
  };

  return sql.begin(async (tx) => {
    await lockChatProjects(tx, input.chatId);
    const candidates = await chatCandidates(tx, input.chatId);
    const matches = candidates.filter((project) => project.slug === slug || project.name.toLowerCase() === name.toLowerCase() || sharesLink(project.links, links));
    const isOwn = (project: Candidate) => project.author_ids.includes(input.actorUserId);
    const shown = matches.filter((project) => !project.hidden);
    const own = shown.find(isOwn);
    if (own) {
      const result = await applyEdit(tx, own, fields, { source: "user", actorUserId: input.actorUserId }, { activityAt: new Date() });
      return { outcome: "own", ...result };
    }
    if (shown[0]) return { outcome: "exists", project: shown[0], changed: false };
    const deleted = matches.find((project) => project.hidden && isOwn(project) && (project.slug === slug || project.name.toLowerCase() === name.toLowerCase()));
    if (deleted) {
      const result = await applyEdit(tx, deleted, fields, { source: "user", actorUserId: input.actorUserId }, { activityAt: new Date(), restore: true });
      return { outcome: "restored", ...result };
    }
    const values: EditableValues = { tagline: fields.tagline ?? null, status: input.status ?? "in_progress", stack: [...new Set(input.stack ?? [])], links };
    const project = await insertProject(
      tx,
      { chatId: input.chatId, slug, name, ...values, status: input.status ?? null, manualFields: filledFields(values, input.status !== undefined) },
      { confidence: 1, firstSeenMsgId: input.sourceMsgIds?.[0] ?? null, activityAt: new Date(), sourceMsgIds: input.sourceMsgIds ?? [], source: "user", actorUserId: input.actorUserId },
    );
    await addAuthors(tx, project.id, [input.actorUserId]);
    return { outcome: "created", project, changed: true };
  });
}

/** The base slug if the chat does not use it yet (deleted projects keep theirs), else base-2, base-3… */
export async function freeSlug(sql: Queryable, chatId: number, base: string): Promise<string> {
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
  const hidden = await sql`UPDATE projects SET hidden = true, updated_at = now() WHERE id = ${projectId} AND NOT hidden RETURNING id`;
  if (hidden.length === 0) return;
  await sql`INSERT INTO change_log (entity, entity_id, op, source, actor_user_id) VALUES ('project', ${projectId}, 'hide', 'user', ${actorUserId})`;
}

export async function setMemberRole(sql: Sql, projectId: number, userId: number, role: string | null): Promise<void> {
  await sql`
    INSERT INTO project_members (project_id, user_id, role) VALUES (${projectId}, ${userId}, ${role})
    ON CONFLICT (project_id, user_id) DO UPDATE SET role = excluded.role`;
}

/** A folded project's aliases name the project it went into; one that project already has is dropped. */
export async function moveProjectAliases(tx: Queryable, fromId: number, intoId: number): Promise<void> {
  await tx`
    UPDATE aliases a SET project_id = ${intoId}
    WHERE a.project_id = ${fromId}
      AND NOT EXISTS (SELECT 1 FROM aliases x WHERE x.chat_id = a.chat_id AND x.project_id = ${intoId} AND x.alias_norm = a.alias_norm)`;
  await tx`DELETE FROM aliases WHERE project_id = ${fromId}`;
}

/** Folds duplicate catalog entries into one: authors, votes, signals, aliases and links move over, the rest is hidden. */
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
      await moveProjectAliases(tx, project.id, into.id);
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
      // The folded entry remembers where it went, so a later mention of its old slug reaches the surviving project.
      await tx`
        INSERT INTO change_log (entity, entity_id, op, after, source)
        VALUES ('project', ${project.id}, 'merged_into', ${tx.json({ into: into.id, slug: into.slug })}, 'llm')`;
    }
    return from.length;
  });
}
