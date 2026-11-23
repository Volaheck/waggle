import type { Sql } from "../core/db.js";
import { createGithub, GithubRateLimitError, githubRepoOf, GithubUnreachableError, readRepo, saveRepoRead, type Github, type RepoRead } from "../core/repos.js";

const HOUR_MS = 60 * 60 * 1000;
const START_DELAY_MS = 60_000;
/** A repo link the API can be asked about, in a form SQL matches; githubRepoOf has the last word. */
const GITHUB_LINK = String.raw`^https?://(www\.)?github\.com/[^/]+/[^/]+`;

export interface RepoCheck {
  /** Projects whose reading was kept, of them read with their latest commits (first read, or pushed to since), and with no public repository at the link. */
  read: number;
  withCommits: number;
  none: number;
  failed: number;
  /** Readings dropped: their project lost its link, was hidden, left an approved chat or has an author who stopped the collecting. */
  dropped: number;
  calls: number;
  left: number | null;
  /** Set when GitHub's hourly limit stopped the round: the rest wait until then. */
  limitedUntil: Date | null;
  /** Set when GitHub could not be reached at all, which ended the round after one try. */
  unreachable: string | null;
}

/** A project whose author stopped the bot's collecting about them in its chat. */
function optedOutAuthor(sql: Sql) {
  return sql`
    SELECT 1 FROM project_members pm JOIN members m ON m.user_id = pm.user_id AND m.chat_id = p.chat_id
    WHERE pm.project_id = p.id AND m.opted_out`;
}

async function dropStaleReads(sql: Sql): Promise<number> {
  const dropped = await sql`
    DELETE FROM project_repos r USING projects p
    WHERE r.project_id = p.id
      AND (p.hidden OR coalesce(p.links->>'repo', '') !~* ${GITHUB_LINK}
           OR NOT EXISTS (SELECT 1 FROM chats c WHERE c.id = p.chat_id AND c.status = 'approved')
           OR EXISTS (${optedOutAuthor(sql)}))`;
  return dropped.count;
}

/**
 * The shown projects of approved chats with a GitHub repo link that are due a reading: never read, read from another
 * link, or read `checkHours` ago (half an hour early, so an hourly round keeps the time of day), the oldest first.
 */
async function dueProjects(sql: Sql, checkHours: number) {
  return sql<{ id: number; link: string; read_link: string | null; full_name: string | null; pushed_at: Date | null }[]>`
    SELECT p.id, p.links->>'repo' AS link, r.link AS read_link, r.full_name, r.pushed_at
    FROM projects p
    JOIN chats c ON c.id = p.chat_id AND c.status = 'approved'
    LEFT JOIN project_repos r ON r.project_id = p.id
    WHERE NOT p.hidden AND p.links->>'repo' ~* ${GITHUB_LINK} AND NOT EXISTS (${optedOutAuthor(sql)})
      AND (r.project_id IS NULL OR r.link <> p.links->>'repo' OR r.checked_at < now() - make_interval(mins => ${Math.max(1, Math.round(checkHours * 60 - 30))}))
    ORDER BY r.checked_at NULLS FIRST, p.id`;
}

/**
 * One round: drops the readings that no longer hold, then reads the repositories that are due, each once however many
 * projects link it. A failed reading waits for the next round; GitHub's hourly limit ends the round.
 */
export async function checkRepos(sql: Sql, options: { github: Github; checkHours: number; stop?: AbortSignal; log?: (line: string) => void }): Promise<RepoCheck> {
  const log = options.log ?? ((line: string) => console.log(line));
  const result: RepoCheck = { read: 0, withCommits: 0, none: 0, failed: 0, dropped: await dropStaleReads(sql), calls: 0, left: null, limitedUntil: null, unreachable: null };
  const reads = new Map<string, RepoRead>();
  for (const project of await dueProjects(sql, options.checkHours)) {
    if (options.stop?.aborted) break;
    const repo = githubRepoOf(project.link);
    if (!repo) continue;
    const previous = project.read_link === project.link ? { full_name: project.full_name, pushed_at: project.pushed_at } : undefined;
    const key = [repo.owner.toLowerCase(), repo.name.toLowerCase(), previous?.full_name ?? "", previous?.pushed_at?.toISOString() ?? ""].join("|");
    try {
      const read = reads.get(key) ?? (await readRepo(options.github, repo, previous));
      reads.set(key, read);
      if (options.stop?.aborted) break;
      // A project that stopped being readable while the round went on keeps nothing.
      if (!(await saveRepoRead(sql, project.id, project.link, read))) continue;
      result.read += 1;
      if (read.kind === "none") result.none += 1;
      else if (read.latest !== null) result.withCommits += 1;
    } catch (error) {
      if (error instanceof GithubRateLimitError) {
        result.limitedUntil = error.until;
        break;
      }
      if (options.stop?.aborted) break;
      if (error instanceof GithubUnreachableError) {
        result.unreachable = error.message;
        break;
      }
      result.failed += 1;
      log(`[repos] project ${project.id}: its repository was not read, the next round tries again: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  result.calls = options.github.calls;
  result.left = options.github.left;
  return result;
}

/**
 * Reads the catalog's GitHub repositories every hour, each of them once in `checkHours` (0 turns it off). Returns a
 * function that stops it: a call under way is cancelled, and the round ends there.
 */
export function startRepoWatch(options: {
  sql: Sql;
  checkHours: number;
  fetch?: typeof fetch;
  everyMs?: number;
  startDelayMs?: number;
  log?: (line: string) => void;
}): () => Promise<void> {
  if (options.checkHours <= 0) return async () => {};
  const log = options.log ?? ((line: string) => console.log(line));
  const stop = new AbortController();
  let limitedUntil = 0;
  let current: Promise<void> | undefined;
  const run = () => {
    if (current || stop.signal.aborted || Date.now() < limitedUntil) return;
    current = (async () => {
      try {
        const github = createGithub(options.fetch, { stop: stop.signal });
        const done = await checkRepos(options.sql, { github, checkHours: options.checkHours, stop: stop.signal, log });
        if (done.limitedUntil) limitedUntil = done.limitedUntil.getTime();
        if (done.unreachable) log(`[repos] ${done.unreachable}; the next round tries again`);
        else if (done.read || done.dropped || done.failed || done.limitedUntil) {
          log(
            `[repos] read ${done.read} repo(s): ${done.withCommits} with their latest commits, ${done.none} with no public repository at the link; ${done.failed} failed, ${done.dropped} dropped; ${done.calls} call(s) to GitHub, ${done.left ?? "?"} left this hour${done.limitedUntil ? `; the limit is spent until ${done.limitedUntil.toISOString()}` : ""}`,
          );
        }
      } catch (error) {
        if (!stop.signal.aborted) log(`[repos] the round failed, the next one is in an hour: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        current = undefined;
      }
    })();
  };
  const first = setTimeout(run, options.startDelayMs ?? START_DELAY_MS);
  const timer = setInterval(run, options.everyMs ?? HOUR_MS);
  return async () => {
    stop.abort();
    clearTimeout(first);
    clearInterval(timer);
    await current;
  };
}
