import { z } from "zod";
import type { Queryable, Sql } from "./db.js";
import type { ProjectStatus } from "./projects.js";
import { truncate } from "./text.js";

/**
 * The public GitHub repositories linked on catalog projects, as the bot reads them (src/worker/repos.ts): the date and
 * the titles of the latest commits on the default branch, bots' left out, and the latest release. Never the code, the
 * changes, or who made them: the owners took the weekly idea on those terms (2026-11-10). Only public repositories,
 * read without a token.
 */

export const REPO_COMMITS = 5;
export const COMMIT_TITLE_CHARS = 120;
/** A project still "in progress" with no commit and no word on its status for this long looks paused… */
export const QUIET_DAYS = 30;
/** …and a paused or abandoned one with a commit this recent, made after its status was set, looks active again. */
export const ACTIVE_AGAIN_DAYS = 14;
/** A reading older than this is not shown: the watch is off, or GitHub has been out of reach for that long. */
export const STALE_DAYS = 7;
/** Calls the hour's limit keeps back for whatever else on the server talks to GitHub. */
export const RATE_RESERVE = 10;

const API = "https://api.github.com";
const HEADERS = { Accept: "application/vnd.github+json", "User-Agent": "waggle-bot", "X-GitHub-Api-Version": "2022-11-28" };
const TIMEOUT_MS = 15_000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Enough of the latest commits that five are left once merges and bots' are out. */
const COMMIT_PAGE = 20;
/** GitHub's secondary limit can answer 403 with nothing but this in its message; a minute's wait is what it asks. */
const SECONDARY_LIMIT_MS = 60_000;

export interface RepoCommit {
  sha: string;
  title: string;
  at: string;
}

export interface RepoRelease {
  tag: string;
  /** Its title, when it says more than the tag. */
  name: string | null;
  at: string;
  prerelease: boolean;
}

/** What the bot last read of a project's repository; `full_name` is null when the link leads to no public repository. */
export interface RepoSnapshot {
  project_id: number;
  link: string;
  full_name: string | null;
  archived: boolean;
  language: string | null;
  /** The last push to any branch, as GitHub has it. */
  pushed_at: Date | null;
  /** The latest commit on the default branch that no bot made: the project's own latest work. */
  committed_at: Date | null;
  commits: RepoCommit[];
  release: RepoRelease | null;
  checked_at: Date;
}

export interface GithubRepo {
  owner: string;
  name: string;
}

const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** owner/name of a github.com repository link («https://github.com/kit/atlas/tree/main» is kit/atlas); null for any other link. */
export function githubRepoOf(link: string | null | undefined): GithubRepo | null {
  if (!link) return null;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !/^(?:www\.)?github\.com$/i.test(url.hostname)) return null;
  const [owner, path] = url.pathname.split("/").filter(Boolean);
  const name = path?.replace(/\.git$/i, "");
  if (!owner || !name || !OWNER.test(owner) || !NAME.test(name) || /^\.+$/.test(name)) return null;
  return { owner, name };
}

export class GithubRateLimitError extends Error {
  constructor(readonly until: Date) {
    super(`GitHub's rate limit is spent until ${until.toISOString()}`);
  }
}

/** GitHub did not answer at all (the network, a timeout): the other repositories would fare no better. */
export class GithubUnreachableError extends Error {
  constructor(cause: unknown) {
    super(`GitHub could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

export interface Github {
  /** The JSON at an API path, or only the status when it is not 200. Throws when the call fails or a limit is reached. */
  get(path: string): Promise<{ status: number; body?: unknown }>;
  /** Calls made, and what GitHub last said the hour's limit has left (null before the first answer). */
  readonly calls: number;
  readonly left: number | null;
}

/** A client that keeps `reserve` calls of the hour's limit untouched and stops once only they are left; `stop` cancels a call under way. */
export function createGithub(fetchImpl: typeof fetch = fetch, options: { reserve?: number; stop?: AbortSignal } = {}): Github {
  const reserve = options.reserve ?? RATE_RESERVE;
  let calls = 0;
  let left: number | null = null;
  let resetAt: Date | null = null;
  const header = (response: Response, name: string): number | null => {
    const value = response.headers.get(name);
    return value === null || !Number.isFinite(Number(value)) ? null : Number(value);
  };
  return {
    get calls() {
      return calls;
    },
    get left() {
      return left;
    },
    async get(path) {
      if (left !== null && left <= reserve && resetAt && resetAt.getTime() > Date.now()) throw new GithubRateLimitError(resetAt);
      calls += 1;
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      // Whatever fails on the way, the body as much as the headers, is GitHub out of reach, unless a stop cut it short.
      const unreachable = (error: unknown): never => {
        throw options.stop?.aborted ? error : new GithubUnreachableError(error);
      };
      const response = await fetchImpl(`${API}${path}`, { headers: HEADERS, signal: options.stop ? AbortSignal.any([timeout, options.stop]) : timeout }).catch(unreachable);
      const drop = () => response.body?.cancel().catch(() => {});
      left = header(response, "x-ratelimit-remaining") ?? left;
      const reset = header(response, "x-ratelimit-reset");
      if (reset !== null) resetAt = new Date(reset * 1000);
      const retryAfter = header(response, "retry-after");
      if (response.status === 429 || (response.status === 403 && (left === 0 || retryAfter !== null))) {
        await drop();
        throw new GithubRateLimitError(retryAfter ? new Date(Date.now() + retryAfter * 1000) : (resetAt ?? new Date(Date.now() + 60 * 60 * 1000)));
      }
      if (response.status >= 500) {
        await drop();
        throw new Error(`GitHub answered ${response.status} for ${path}`);
      }
      if (response.status === 403) {
        // A blocked repository and the secondary limit both answer 403; only the message tells them apart.
        const message = await response.text().catch(unreachable);
        if (/rate limit/i.test(message)) throw new GithubRateLimitError(new Date(Date.now() + SECONDARY_LIMIT_MS));
        return { status: 403 };
      }
      if (response.status !== 200) {
        await drop();
        return { status: response.status };
      }
      const body = await response.text().catch(unreachable);
      try {
        return { status: 200, body: JSON.parse(body) as unknown };
      } catch {
        throw new Error(`GitHub's answer for ${path} is not JSON`);
      }
    },
  };
}

const RepoInfo = z.object({
  full_name: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/),
  private: z.boolean(),
  archived: z.boolean().default(false),
  language: z.string().max(60).nullable().default(null),
  pushed_at: z.string().nullable().default(null),
});

const Dated = z.object({ name: z.string().optional(), date: z.string() }).nullable().optional();
const Commits = z.array(
  z.object({
    sha: z.string().regex(/^[0-9a-f]{7,64}$/i),
    parents: z.array(z.unknown()).default([]),
    author: z.object({ login: z.string().optional(), type: z.string().optional() }).nullable().optional(),
    commit: z.object({ message: z.string(), committer: Dated, author: Dated }),
  }),
);

const Releases = z.array(
  z.object({
    tag_name: z.string(),
    name: z.string().nullable().optional(),
    draft: z.boolean().default(false),
    prerelease: z.boolean().default(false),
    published_at: z.string().nullable().optional(),
    created_at: z.string(),
  }),
);

/**
 * What one reading found: a public repository, with its latest commits unless nothing was pushed since the last reading
 * (`latest` null: they are as they were), or no public repository at all.
 */
export type RepoRead =
  | {
      kind: "public";
      full_name: string;
      archived: boolean;
      language: string | null;
      pushed_at: Date | null;
      latest: { commits: RepoCommit[]; committed_at: Date | null } | null;
      release: RepoRelease | null;
    }
  | { kind: "none" };

/** A commit's title: the first line of its message. */
export function commitTitle(message: string): string {
  return truncate((message.split("\n")[0] ?? "").replace(/\s+/g, " ").trim(), COMMIT_TITLE_CHARS);
}

function apiPath(fullName: string): string {
  return `/repos/${fullName.split("/").map(encodeURIComponent).join("/")}`;
}

function dateOf(text: string | null | undefined): Date | null {
  const date = text ? new Date(text) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}

const BOT_NAME = /\[bot\]$/i;
type ListedCommit = z.infer<typeof Commits>[number];
const madeByBot = (commit: ListedCommit) => commit.author?.type === "Bot" || BOT_NAME.test(commit.author?.login ?? "") || BOT_NAME.test(commit.commit.author?.name ?? "");

/**
 * The latest commits on the default branch that no bot made (Dependabot's, Renovate's, an action's): the titles of the
 * latest five that are no merge, and when the latest of them all landed, no later than the push that brought it.
 */
async function latestCommits(github: Github, base: string, pushedAt: Date | null): Promise<{ commits: RepoCommit[]; committed_at: Date | null }> {
  const listed = await github.get(`${base}/commits?per_page=${COMMIT_PAGE}`);
  // 409: the repository is empty.
  if (listed.status === 409) return { commits: [], committed_at: null };
  if (listed.status !== 200) throw new Error(`GitHub answered ${listed.status} for the commits of ${base}`);
  const parsed = Commits.safeParse(listed.body);
  if (!parsed.success) throw new Error(`GitHub's answer for the commits of ${base} is not a list of commits`);
  const people = parsed.data.filter((commit) => !madeByBot(commit));
  const landed = (commit: ListedCommit) => dateOf(commit.commit.committer?.date ?? commit.commit.author?.date);
  const latest = people.map(landed).reduce<Date | null>((newest, at) => (at && (!newest || at > newest) ? at : newest), null);
  // A commit's date is the committer's clock; it never comes after the push that brought it.
  const ceiling = pushedAt ?? new Date();
  const commits = people
    .filter((commit) => commit.parents.length < 2)
    .flatMap((commit) => {
      const title = commitTitle(commit.commit.message);
      const at = landed(commit);
      return title && at ? [{ sha: commit.sha, title, at: (at > ceiling ? ceiling : at).toISOString() }] : [];
    })
    .slice(0, REPO_COMMITS);
  return { commits, committed_at: latest && latest > ceiling ? ceiling : latest };
}

async function latestRelease(github: Github, base: string): Promise<RepoRelease | null> {
  const listed = await github.get(`${base}/releases?per_page=5`);
  if (listed.status !== 200) throw new Error(`GitHub answered ${listed.status} for the releases of ${base}`);
  const releases = Releases.safeParse(listed.body);
  if (!releases.success) throw new Error(`GitHub's answer for the releases of ${base} is not a list of releases`);
  const release = releases.data.find((candidate) => !candidate.draft);
  const at = release && dateOf(release.published_at ?? release.created_at);
  if (!release || !at) return null;
  const tag = truncate(release.tag_name.trim(), 60);
  const name = release.name?.replace(/\s+/g, " ").trim() ?? "";
  return { tag, name: name && name !== tag ? truncate(name, 80) : null, at: at.toISOString(), prerelease: release.prerelease };
}

/**
 * Reads a repository: what GitHub says of it, its latest release and, unless `previous` was read under the same name with
 * the same last push, its latest commits. A private repository (one a token could see) counts as none.
 */
export async function readRepo(github: Github, repo: GithubRepo, previous?: { full_name: string | null; pushed_at: Date | null }): Promise<RepoRead> {
  const path = apiPath(`${repo.owner}/${repo.name}`);
  const found = await github.get(path);
  if (found.status === 404 || found.status === 403 || found.status === 410 || found.status === 451) return { kind: "none" };
  if (found.status !== 200) throw new Error(`GitHub answered ${found.status} for ${path}`);
  const info = RepoInfo.safeParse(found.body);
  if (!info.success) throw new Error(`GitHub's answer for ${path} is not a repository`);
  if (info.data.private) return { kind: "none" };
  const pushedAt = dateOf(info.data.pushed_at);
  const base = apiPath(info.data.full_name);
  const unchanged = previous?.full_name === info.data.full_name && previous.pushed_at?.getTime() === pushedAt?.getTime();
  return {
    kind: "public",
    full_name: info.data.full_name,
    archived: info.data.archived,
    language: info.data.language,
    pushed_at: pushedAt,
    latest: unchanged ? null : await latestCommits(github, base, pushedAt),
    release: await latestRelease(github, base),
  };
}

/** A project the bot may keep a reading for: shown, still linking `link`, and with no author who stopped its collecting. */
function readable(sql: Queryable, projectId: number, link: string) {
  return sql`
    SELECT 1 FROM projects p
    WHERE p.id = ${projectId} AND NOT p.hidden AND p.links->>'repo' = ${link}
      AND NOT EXISTS (
        SELECT 1 FROM project_members pm JOIN members m ON m.user_id = pm.user_id AND m.chat_id = p.chat_id
        WHERE pm.project_id = p.id AND m.opted_out)`;
}

/**
 * Keeps a reading for the project, and its latest commit as its latest activity. Nothing is kept for a project that
 * stopped being readable while it was read (an author stopped the collecting, its link changed): false then. The rows of
 * its authors' cards are locked first, so an author stopping the collecting at that moment either waits for the reading,
 * and then deletes it with the rest, or is seen to have stopped it.
 */
export async function saveRepoRead(sql: Sql, projectId: number, link: string, read: RepoRead): Promise<boolean> {
  return sql.begin(async (tx) => {
    const authors = await tx<{ opted_out: boolean }[]>`
      SELECT m.opted_out FROM project_members pm JOIN projects p ON p.id = pm.project_id
      JOIN members m ON m.user_id = pm.user_id AND m.chat_id = p.chat_id
      WHERE pm.project_id = ${projectId}
      FOR SHARE OF m`;
    if (authors.some((author) => author.opted_out)) return false;
    return keepRepoRead(tx, projectId, link, read);
  });
}

async function keepRepoRead(sql: Queryable, projectId: number, link: string, read: RepoRead): Promise<boolean> {
  if (read.kind === "none") {
    const kept = await sql`
      INSERT INTO project_repos (project_id, link, full_name, checked_at)
      SELECT ${projectId}::int, ${link}::text, NULL, now() WHERE EXISTS (${readable(sql, projectId, link)})
      ON CONFLICT (project_id) DO UPDATE SET link = excluded.link, full_name = NULL, archived = false, language = NULL, pushed_at = NULL,
        committed_at = NULL, commits = '[]'::jsonb, release = NULL, checked_at = now()
      RETURNING project_id`;
    return kept.length > 0;
  }
  const { latest } = read;
  const [kept] = await sql<{ committed_at: Date | null }[]>`
    INSERT INTO project_repos (project_id, link, full_name, archived, language, pushed_at, committed_at, commits, release, checked_at)
    SELECT ${projectId}::int, ${link}::text, ${read.full_name}::text, ${read.archived}::boolean, ${read.language}::text, ${read.pushed_at}::timestamptz,
           ${latest?.committed_at ?? null}::timestamptz, ${sql.json(latest?.commits ?? [])}::jsonb, ${read.release ? sql.json(read.release) : null}::jsonb, now()
    WHERE EXISTS (${readable(sql, projectId, link)})
    ON CONFLICT (project_id) DO UPDATE SET link = excluded.link, full_name = excluded.full_name, archived = excluded.archived,
      language = excluded.language, pushed_at = excluded.pushed_at, release = excluded.release, checked_at = now(),
      commits = ${latest ? sql`excluded.commits` : sql`project_repos.commits`},
      committed_at = ${
        latest
          ? // A page of nothing but bots' commits says nothing new of the project's own work in the same repository.
            sql`CASE WHEN project_repos.full_name IS NOT DISTINCT FROM excluded.full_name THEN coalesce(excluded.committed_at, project_repos.committed_at) ELSE excluded.committed_at END`
          : sql`project_repos.committed_at`
      }
    RETURNING committed_at`;
  if (!kept) return false;
  if (kept.committed_at) await sql`UPDATE projects SET last_activity_at = greatest(last_activity_at, ${kept.committed_at}) WHERE id = ${projectId}`;
  return true;
}

/**
 * The readings to show for the projects: made from the link each project has now, at most STALE_DAYS ago, of a shown
 * project with no author who stopped the collecting.
 */
export async function repoSnapshots(sql: Queryable, projectIds: number[]): Promise<Map<number, RepoSnapshot>> {
  if (projectIds.length === 0) return new Map();
  const rows = await sql<RepoSnapshot[]>`
    SELECT r.* FROM project_repos r JOIN projects p ON p.id = r.project_id
    WHERE r.project_id = ANY(${projectIds}::int[]) AND r.link = p.links->>'repo' AND NOT p.hidden
      AND r.checked_at > now() - make_interval(days => ${STALE_DAYS})
      AND NOT EXISTS (
        SELECT 1 FROM project_members pm JOIN members m ON m.user_id = pm.user_id AND m.chat_id = p.chat_id
        WHERE pm.project_id = p.id AND m.opted_out)`;
  return new Map(rows.map((row) => [row.project_id, row]));
}

export type RepoHint = { kind: "quiet" | "active_again"; days: number };

/**
 * Where the repository says otherwise than the status, which stays its authors' word, as of its reading: an "in
 * progress" project with no commit and no word on its status for QUIET_DAYS looks paused, and a paused or abandoned one
 * with a commit within ACTIVE_AGAIN_DAYS, made after its status was set, looks active again. `days`: since that commit.
 */
export function repoHint(status: ProjectStatus, statusSince: Date | null | undefined, repo: RepoSnapshot | undefined): RepoHint | null {
  if (!repo?.full_name || !repo.committed_at) return null;
  const readAt = repo.checked_at.getTime();
  const days = Math.max(0, Math.floor((readAt - repo.committed_at.getTime()) / DAY_MS));
  const lastWord = Math.max(repo.committed_at.getTime(), statusSince?.getTime() ?? 0);
  if (status === "in_progress" && readAt - lastWord >= QUIET_DAYS * DAY_MS) return { kind: "quiet", days };
  if ((status === "paused" || status === "abandoned") && days < ACTIVE_AGAIN_DAYS && (!statusSince || repo.committed_at > statusSince)) return { kind: "active_again", days };
  return null;
}

/** The repository's own page for a commit. */
export function commitUrl(fullName: string, sha: string): string {
  return `https://github.com/${fullName}/commit/${sha}`;
}
