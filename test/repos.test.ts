import type { Message, UserFromGetMe } from "grammy/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/api/server.js";
import { signInitData } from "../src/api/init-data.js";
import { projectCard } from "../src/bot/format.js";
import { buildReplyContext, promptText, type Question } from "../src/bot/reply-context.js";
import { CAPABILITIES, LIMITS } from "../src/core/capabilities.js";
import { registerChat, setChatStatus } from "../src/core/chats.js";
import { createSql, migrate, type Sql } from "../src/core/db.js";
import { addUserProject, getProjectBySlug, updateProject } from "../src/core/projects.js";
import {
  commitTitle,
  createGithub,
  GithubRateLimitError,
  githubRepoOf,
  GithubUnreachableError,
  QUIET_DAYS,
  readRepo,
  repoHint,
  repoSnapshots,
  saveRepoRead,
  type RepoSnapshot,
} from "../src/core/repos.js";
import { resolveUser, setOptOut, type User } from "../src/core/users.js";
import { checkRepos, startRepoWatch } from "../src/worker/repos.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const TOKEN = "123456:TEST-TOKEN";
const DAY = 24 * 60 * 60 * 1000;
const PUSHED = "2026-11-20T10:00:00Z";
const LATEST_OWN = "2026-11-20T09:59:00Z";
const LONE_HIGH_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;

type Route = { status?: number; body?: unknown; headers?: Record<string, string> };

/** A GitHub API that answers the paths it is given, 404 to the rest, and keeps the paths asked for. */
function fakeGithub(routes: Record<string, Route>, left = 50) {
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const path = String(input).replace("https://api.github.com", "");
    asked.push(path);
    const route = routes[path] ?? { status: 404, body: { message: "Not Found" } };
    left -= 1;
    return new Response(route.body === undefined ? null : JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json", "x-ratelimit-remaining": String(left), "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600), ...route.headers },
    });
  }) as typeof fetch;
  return { fetchImpl, asked };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(10);
  }
}

const repoBody = (fullName = "kit/atlas", extra: Record<string, unknown> = {}) => ({ full_name: fullName, private: false, archived: false, language: "Swift", pushed_at: PUSHED, ...extra });
const COMMITS = [
  { sha: "d".repeat(40), parents: [{}], author: { login: "dependabot[bot]", type: "Bot" }, commit: { message: "Bump lodash from 4.17.20 to 4.17.21", committer: { date: "2026-11-20T09:59:30Z" } } },
  { sha: "a".repeat(40), parents: [{}], author: { login: "kit", type: "User" }, commit: { message: "Fix the login crash\n\nIt crashed on an empty password.", committer: { date: LATEST_OWN } } },
  { sha: "b".repeat(40), parents: [{}, {}], commit: { message: "Merge pull request #3 from kit/widgets", committer: { date: "2026-11-19T12:00:00Z" } } },
  { sha: "e".repeat(40), parents: [{}], author: null, commit: { message: "Update the badges", author: { name: "github-actions[bot]", date: "2026-11-19T11:00:00Z" } } },
  { sha: "c".repeat(40), parents: [{}], commit: { message: `Add ${"very ".repeat(40)}long widgets`, author: { date: "2026-11-18T12:00:00Z" } } },
];
const RELEASES = [{ tag_name: "v0.2.0-beta", name: "v0.2.0-beta", draft: false, prerelease: true, published_at: "2026-11-19T08:00:00Z", created_at: "2026-11-19T08:00:00Z" }];

function atlasRoutes(fullName = "kit/atlas"): Record<string, Route> {
  return {
    [`/repos/${fullName}`]: { body: repoBody(fullName) },
    [`/repos/${fullName}/commits?per_page=20`]: { body: COMMITS },
    [`/repos/${fullName}/releases?per_page=5`]: { body: RELEASES },
  };
}

describe("reading GitHub", () => {
  it("knows a github.com repository by its link, and nothing else", () => {
    expect(githubRepoOf("https://github.com/kit/atlas")).toEqual({ owner: "kit", name: "atlas" });
    expect(githubRepoOf("https://www.github.com/kit/atlas.git")).toEqual({ owner: "kit", name: "atlas" });
    expect(githubRepoOf("https://github.com/kit/atlas/tree/main/src?tab=readme")).toEqual({ owner: "kit", name: "atlas" });
    expect(githubRepoOf("http://GitHub.com/Kit/Atlas")).toEqual({ owner: "Kit", name: "Atlas" });
    expect(githubRepoOf("https://github.com/kit")).toBeNull();
    expect(githubRepoOf("https://github.com/kit/..")).toBeNull();
    expect(githubRepoOf("https://gitlab.com/kit/atlas")).toBeNull();
    expect(githubRepoOf("https://github.com.evil.example/kit/atlas")).toBeNull();
    expect(githubRepoOf("github.com/kit/atlas")).toBeNull();
    expect(githubRepoOf(null)).toBeNull();
  });

  it("keeps the first line of a commit message as its title, cut short and never inside an emoji", () => {
    expect(commitTitle("Fix the crash\n\nbody")).toBe("Fix the crash");
    expect(commitTitle("  spaced   out  ")).toBe("spaced out");
    expect(commitTitle("x".repeat(300))).toHaveLength(120);
    const emojiAtTheCut = commitTitle(`${"a".repeat(118)}🚀 and the rest`);
    expect(emojiAtTheCut).not.toMatch(LONE_HIGH_SURROGATE);
    expect(emojiAtTheCut.endsWith("…")).toBe(true);
  });

  it("reads the latest commits that no bot made, without merges, the latest release, and never more", async () => {
    const { fetchImpl, asked } = fakeGithub(atlasRoutes());
    const read = await readRepo(createGithub(fetchImpl), { owner: "kit", name: "atlas" });
    expect(read).toMatchObject({ kind: "public", full_name: "kit/atlas", archived: false, language: "Swift", pushed_at: new Date(PUSHED) });
    if (read.kind !== "public") throw new Error("not public");
    expect(read.latest!.commits.map((commit) => commit.title)).toEqual(["Fix the login crash", expect.stringMatching(/^Add very very .*…$/)]);
    expect(read.latest!.commits[1]!.at).toBe("2026-11-18T12:00:00.000Z");
    // Dependabot's commit came later, and the merge is the project's own work but no news of its own.
    expect(read.latest!.committed_at).toEqual(new Date(LATEST_OWN));
    expect(read.release).toEqual({ tag: "v0.2.0-beta", name: null, at: "2026-11-19T08:00:00.000Z", prerelease: true });
    expect(asked).toEqual(["/repos/kit/atlas", "/repos/kit/atlas/commits?per_page=20", "/repos/kit/atlas/releases?per_page=5"]);
  });

  it("dates no commit after the push that brought it", async () => {
    const skewed = [{ sha: "f".repeat(40), parents: [{}], commit: { message: "From a clock in the future", committer: { date: "2030-01-01T00:00:00Z" } } }];
    const { fetchImpl } = fakeGithub({ ...atlasRoutes(), "/repos/kit/atlas/commits?per_page=20": { body: skewed } });
    const read = await readRepo(createGithub(fetchImpl), { owner: "kit", name: "atlas" });
    expect(read).toMatchObject({ latest: { committed_at: new Date(PUSHED), commits: [{ at: new Date(PUSHED).toISOString() }] } });
  });

  it("asks for no commits when nothing was pushed since the last reading of the same repository", async () => {
    const { fetchImpl, asked } = fakeGithub(atlasRoutes());
    const read = await readRepo(createGithub(fetchImpl), { owner: "kit", name: "atlas" }, { full_name: "kit/atlas", pushed_at: new Date(PUSHED) });
    expect(read).toMatchObject({ kind: "public", latest: null });
    expect(asked).toEqual(["/repos/kit/atlas", "/repos/kit/atlas/releases?per_page=5"]);
    // Renamed since: it is read in full under its new name.
    const renamed = fakeGithub({ ...atlasRoutes("kit/atlas-app"), "/repos/kit/atlas": { body: repoBody("kit/atlas-app") } });
    const moved = await readRepo(createGithub(renamed.fetchImpl), { owner: "kit", name: "atlas" }, { full_name: "kit/atlas", pushed_at: new Date(PUSHED) });
    expect(moved).toMatchObject({ kind: "public", full_name: "kit/atlas-app", latest: { commits: [{ title: "Fix the login crash" }, {}] } });
  });

  it("finds no public repository where there is none, a private or blocked one included, and no commits in an empty one", async () => {
    const missing = fakeGithub({});
    expect(await readRepo(createGithub(missing.fetchImpl), { owner: "kit", name: "gone" })).toEqual({ kind: "none" });
    const hidden = fakeGithub({ "/repos/kit/secret": { body: repoBody("kit/secret", { private: true }) } });
    expect(await readRepo(createGithub(hidden.fetchImpl), { owner: "kit", name: "secret" })).toEqual({ kind: "none" });
    expect(hidden.asked).toEqual(["/repos/kit/secret"]);
    const blocked = fakeGithub({ "/repos/kit/blocked": { status: 403, body: { message: "Repository access blocked" } } });
    expect(await readRepo(createGithub(blocked.fetchImpl), { owner: "kit", name: "blocked" })).toEqual({ kind: "none" });
    const empty = fakeGithub({
      "/repos/kit/fresh": { body: repoBody("kit/fresh", { pushed_at: null }) },
      "/repos/kit/fresh/commits?per_page=20": { status: 409, body: { message: "Git Repository is empty." } },
      "/repos/kit/fresh/releases?per_page=5": { body: [] },
    });
    expect(await readRepo(createGithub(empty.fetchImpl), { owner: "kit", name: "fresh" })).toMatchObject({ kind: "public", pushed_at: null, latest: { commits: [], committed_at: null }, release: null });
  });

  it("stops at GitHub's limits, the secondary one included, keeping a reserve, and fails on its errors", async () => {
    const spent = fakeGithub({ "/repos/kit/atlas": { status: 403, body: { message: "API rate limit exceeded" }, headers: { "x-ratelimit-remaining": "0" } } });
    await expect(readRepo(createGithub(spent.fetchImpl), { owner: "kit", name: "atlas" })).rejects.toBeInstanceOf(GithubRateLimitError);
    const busy = fakeGithub({ "/repos/kit/atlas": { status: 429, headers: { "retry-after": "120" } } });
    const error = await readRepo(createGithub(busy.fetchImpl), { owner: "kit", name: "atlas" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GithubRateLimitError);
    expect((error as GithubRateLimitError).until.getTime()).toBeGreaterThan(Date.now() + 100_000);
    // The secondary limit may say so in its message alone.
    const secondary = fakeGithub({ "/repos/kit/atlas": { status: 403, body: { message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." } } });
    await expect(readRepo(createGithub(secondary.fetchImpl), { owner: "kit", name: "atlas" })).rejects.toBeInstanceOf(GithubRateLimitError);
    // Ten left is the reserve: the next call is never made.
    const low = fakeGithub(atlasRoutes(), 12);
    const github = createGithub(low.fetchImpl);
    await expect(readRepo(github, { owner: "kit", name: "atlas" })).rejects.toBeInstanceOf(GithubRateLimitError);
    expect(low.asked).toHaveLength(2);
    expect(github.left).toBe(10);
    const down = fakeGithub({ "/repos/kit/atlas": { status: 502 } });
    await expect(readRepo(createGithub(down.fetchImpl), { owner: "kit", name: "atlas" })).rejects.toThrow("GitHub answered 502");
    // A list that is no list leaves the stored reading alone rather than emptying it.
    const odd = fakeGithub({ ...atlasRoutes(), "/repos/kit/atlas/releases?per_page=5": { body: { message: "odd" } } });
    await expect(readRepo(createGithub(odd.fetchImpl), { owner: "kit", name: "atlas" })).rejects.toThrow("not a list of releases");
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(readRepo(createGithub(offline), { owner: "kit", name: "atlas" })).rejects.toBeInstanceOf(GithubUnreachableError);
    // An answer cut off after its headers is GitHub out of reach too, a 403 among them: never "no public repository".
    const cutOff = (status: number) =>
      (async () =>
        new Response(new ReadableStream({ start: (controller) => controller.error(new TypeError("terminated")) }), {
          status,
          headers: { "x-ratelimit-remaining": "40" },
        })) as typeof fetch;
    await expect(readRepo(createGithub(cutOff(200)), { owner: "kit", name: "atlas" })).rejects.toBeInstanceOf(GithubUnreachableError);
    await expect(readRepo(createGithub(cutOff(403)), { owner: "kit", name: "atlas" })).rejects.toBeInstanceOf(GithubUnreachableError);
  });

  it("hints, as of the reading, where the repository says otherwise than the status, and leaves the status alone", () => {
    const readAt = new Date("2026-11-23T12:00:00Z");
    const ago = (days: number) => new Date(readAt.getTime() - days * DAY);
    const repo = (committedDaysAgo: number): RepoSnapshot => ({
      project_id: 1, link: "https://github.com/kit/atlas", full_name: "kit/atlas", archived: false, language: null,
      pushed_at: ago(0), committed_at: ago(committedDaysAgo), commits: [], release: null, checked_at: readAt,
    });
    expect(repoHint("in_progress", ago(100), repo(40))).toEqual({ kind: "quiet", days: 40 });
    // The authors said "in progress" lately: that is their word, and no hint goes against it.
    expect(repoHint("in_progress", ago(10), repo(40))).toBeNull();
    expect(repoHint("in_progress", ago(100), repo(QUIET_DAYS - 1))).toBeNull();
    // Only bots pushed since: a push alone is no work on the project.
    expect(repoHint("paused", ago(20), { ...repo(60), pushed_at: ago(1) })).toBeNull();
    expect(repoHint("paused", ago(20), repo(3))).toEqual({ kind: "active_again", days: 3 });
    expect(repoHint("abandoned", ago(2), repo(3))).toBeNull();
    expect(repoHint("launched", ago(300), repo(200))).toBeNull();
    expect(repoHint("in_progress", ago(100), { ...repo(40), full_name: null })).toBeNull();
    expect(repoHint("in_progress", ago(100), { ...repo(40), committed_at: null })).toBeNull();
    expect(repoHint("in_progress", ago(100), undefined)).toBeNull();
  });

  it("is in the list of what the bot can do, and in what it cannot", () => {
    expect(CAPABILITIES.repos.shipped).toBe("2026-11-23");
    expect(CAPABILITIES.repos.does).toContain("never its code");
    expect(LIMITS.web).toContain("public GitHub repository");
  });
});

describe.skipIf(!DATABASE_URL)("the catalog's repositories", () => {
  let sql: Sql;
  let nextChat = -1001000000900;
  let nextTgId = 9900;
  let nextMsgId = 90_000;
  const me = { id: 42, is_bot: true, first_name: "Waggle", username: "waggle_test_bot", can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false } as unknown as UserFromGetMe;

  beforeAll(async () => {
    sql = createSql(DATABASE_URL!);
    await sql`DROP SCHEMA public CASCADE`;
    await sql`CREATE SCHEMA public`;
    await migrate(sql);
  });

  afterAll(async () => {
    await sql?.end();
  });

  /** A new approved chat; the bot leaves the chats of the tests before, so their projects are not due any more. */
  async function newChat(options: { alone?: boolean } = { alone: true }): Promise<number> {
    nextChat -= 1;
    if (options.alone) await sql`UPDATE chats SET status = 'left'`;
    await registerChat(sql, nextChat, "Hive", null);
    await setChatStatus(sql, nextChat, "approved", null);
    return nextChat;
  }

  const member = (chatId: number, name: string, tgId = ++nextTgId): Promise<User> => resolveUser(sql, { id: tgId, first_name: name }, [], chatId);
  const project = async (chatId: number, author: User, name: string, repo: string | null) =>
    (await addUserProject(sql, { chatId, name, actorUserId: author.id, links: { repo } })).project;
  const check = (fetchImpl: typeof fetch) => checkRepos(sql, { github: createGithub(fetchImpl), checkHours: 24, log: () => {} });
  const readOf = async (routes: Record<string, Route>, repo = { owner: "kit", name: "atlas" }) => readRepo(createGithub(fakeGithub(routes).fetchImpl), repo);

  it("reads each shown project's GitHub repository once a day, and a changed link at once", async () => {
    const chat = await newChat();
    const kit = await member(chat, "Kit");
    const atlas = await project(chat, kit, "Atlas", "https://github.com/kit/atlas");
    const relic = await project(chat, kit, "Relic", "https://gitlab.com/kit/relic");
    const hidden = await project(chat, kit, "Draft", "https://github.com/kit/draft");
    await sql`UPDATE projects SET hidden = true WHERE id = ${hidden.id}`;
    await sql`UPDATE projects SET last_activity_at = NULL WHERE id = ${atlas.id}`;

    const first = fakeGithub(atlasRoutes());
    expect(await check(first.fetchImpl)).toMatchObject({ read: 1, withCommits: 1, none: 0, failed: 0, calls: 3 });
    const snapshots = await repoSnapshots(sql, [atlas.id, relic.id, hidden.id]);
    expect([...snapshots.keys()]).toEqual([atlas.id]);
    expect(snapshots.get(atlas.id)).toMatchObject({
      full_name: "kit/atlas", pushed_at: new Date(PUSHED), committed_at: new Date(LATEST_OWN), commits: [{ title: "Fix the login crash" }, {}], release: { tag: "v0.2.0-beta" },
    });
    // The latest commit of its own is the project's latest activity.
    const [activity] = await sql<{ last_activity_at: Date }[]>`SELECT last_activity_at FROM projects WHERE id = ${atlas.id}`;
    expect(activity!.last_activity_at).toEqual(new Date(LATEST_OWN));

    const again = fakeGithub(atlasRoutes());
    expect(await check(again.fetchImpl)).toMatchObject({ read: 0, calls: 0 });

    await updateProject(sql, { chatId: chat, projectId: atlas.id, links: { repo: "https://github.com/kit/atlas-next" }, source: "user", actorUserId: kit.id });
    expect((await repoSnapshots(sql, [atlas.id])).size).toBe(0);
    const moved = fakeGithub({});
    expect(await check(moved.fetchImpl)).toMatchObject({ read: 1, none: 1 });
    expect((await repoSnapshots(sql, [atlas.id])).get(atlas.id)).toMatchObject({ link: "https://github.com/kit/atlas-next", full_name: null, committed_at: null, commits: [] });

    // A day later it is read again; with no push since, its commits are not asked for and stay as they were.
    await updateProject(sql, { chatId: chat, projectId: atlas.id, links: { repo: "https://github.com/kit/atlas" }, source: "user", actorUserId: kit.id });
    await check(fakeGithub(atlasRoutes()).fetchImpl);
    await sql`UPDATE project_repos SET checked_at = now() - interval '25 hours' WHERE project_id = ${atlas.id}`;
    const daily = fakeGithub({ ...atlasRoutes(), "/repos/kit/atlas/commits?per_page=20": { body: [] } });
    expect(await check(daily.fetchImpl)).toMatchObject({ read: 1, withCommits: 0 });
    expect(daily.asked).not.toContain("/repos/kit/atlas/commits?per_page=20");
    expect((await repoSnapshots(sql, [atlas.id])).get(atlas.id)).toMatchObject({ committed_at: new Date(LATEST_OWN), commits: [{}, {}] });

    // A push of bots' commits alone: the project's own latest commit stays what it was.
    await sql`UPDATE project_repos SET checked_at = now() - interval '25 hours' WHERE project_id = ${atlas.id}`;
    const bots = fakeGithub({
      ...atlasRoutes(),
      "/repos/kit/atlas": { body: repoBody("kit/atlas", { pushed_at: "2026-11-22T10:00:00Z" }) },
      "/repos/kit/atlas/commits?per_page=20": { body: [COMMITS[0]] },
    });
    expect(await check(bots.fetchImpl)).toMatchObject({ read: 1, withCommits: 1 });
    expect((await repoSnapshots(sql, [atlas.id])).get(atlas.id)).toMatchObject({ pushed_at: new Date("2026-11-22T10:00:00Z"), committed_at: new Date(LATEST_OWN), commits: [] });

    // A reading a week old is not shown.
    await sql`UPDATE project_repos SET checked_at = now() - interval '8 days' WHERE project_id = ${atlas.id}`;
    expect((await repoSnapshots(sql, [atlas.id])).size).toBe(0);

    // Without its link, the reading goes.
    await updateProject(sql, { chatId: chat, projectId: atlas.id, links: { repo: null }, source: "user", actorUserId: kit.id });
    expect(await check(fakeGithub({}).fetchImpl)).toMatchObject({ read: 0, dropped: 1 });
    expect(await sql`SELECT 1 FROM project_repos WHERE project_id = ${atlas.id}`).toHaveLength(0);
  });

  it("keeps a title cut next to an emoji", async () => {
    const chat = await newChat();
    const kit = await member(chat, "Kit");
    const atlas = await project(chat, kit, "Atlas", "https://github.com/kit/atlas");
    const emoji = [{ sha: "a".repeat(40), parents: [{}], commit: { message: `${"a".repeat(118)}🚀 shipped`, committer: { date: LATEST_OWN } } }];
    const read = await readOf({ ...atlasRoutes(), "/repos/kit/atlas/commits?per_page=20": { body: emoji } });
    expect(await saveRepoRead(sql, atlas.id, "https://github.com/kit/atlas", read)).toBe(true);
    expect((await repoSnapshots(sql, [atlas.id])).get(atlas.id)!.commits[0]!.title).toMatch(/^a{118}…$/);
  });

  it("reads one repository once for every project that links it, and stops for the hour at the limit or when GitHub is out of reach", async () => {
    const chat = await newChat();
    const kit = await member(chat, "Kit");
    const other = await newChat({ alone: false });
    const kitThere = await member(other, "Kit", kit.tg_id!);
    const one = await project(chat, kit, "Comet", "https://github.com/kit/comet");
    const two = await project(other, kitThere, "Comet", "https://github.com/kit/comet");
    const both = fakeGithub(atlasRoutes("kit/comet"));
    expect(await check(both.fetchImpl)).toMatchObject({ read: 2, calls: 3 });
    expect((await repoSnapshots(sql, [one.id, two.id])).size).toBe(2);

    await project(chat, kit, "Orbit", "https://github.com/kit/orbit");
    await project(chat, kit, "Pulse", "https://github.com/kit/pulse");
    const spent = fakeGithub({ "/repos/kit/orbit": { status: 403, headers: { "x-ratelimit-remaining": "0" } } });
    const stopped = await check(spent.fetchImpl);
    expect(stopped).toMatchObject({ read: 0 });
    expect(stopped.limitedUntil).toBeInstanceOf(Date);
    expect(spent.asked).toEqual(["/repos/kit/orbit"]);

    // GitHub out of reach: one try, one line, and the round ends.
    const lines: string[] = [];
    let tries = 0;
    const offline = (async () => {
      tries += 1;
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect(await checkRepos(sql, { github: createGithub(offline), checkHours: 24, log: (line) => lines.push(line) })).toMatchObject({
      read: 0,
      failed: 0,
      unreachable: "GitHub could not be reached: fetch failed",
    });
    expect(tries).toBe(1);
    expect(lines).toEqual([]);
  });

  it("reads nothing of a project whose author stopped the collecting, keeps nothing read while they stopped it, and forgets what it read", async () => {
    const chat = await newChat();
    const kit = await member(chat, "Kit");
    const mia = await member(chat, "Mia");
    const atlas = await project(chat, kit, "Atlas", "https://github.com/kit/atlas");
    const nova = await project(chat, mia, "Nova", "https://github.com/mia/nova");
    const read = await readOf(atlasRoutes("mia/nova"), { owner: "mia", name: "nova" });
    await saveRepoRead(sql, nova.id, "https://github.com/mia/nova", read);
    await setOptOut(sql, mia.id, true, chat);
    expect((await repoSnapshots(sql, [nova.id])).size).toBe(0);
    const routes = fakeGithub({ ...atlasRoutes(), ...atlasRoutes("mia/nova") });
    expect(await check(routes.fetchImpl)).toMatchObject({ read: 1 });
    expect(routes.asked.some((path) => path.includes("mia/nova"))).toBe(false);

    // A reading made before they stopped it, and kept after, is kept nowhere and shown nowhere.
    expect(await saveRepoRead(sql, nova.id, "https://github.com/mia/nova", read)).toBe(false);
    expect(await sql`SELECT 1 FROM project_repos WHERE project_id = ${nova.id}`).toHaveLength(0);
    await sql`INSERT INTO project_repos (project_id, link, full_name) VALUES (${nova.id}, 'https://github.com/mia/nova', 'mia/nova')`;
    expect((await repoSnapshots(sql, [nova.id])).size).toBe(0);
    // Nor one for a link the project no longer has.
    expect(await saveRepoRead(sql, atlas.id, "https://github.com/kit/old-atlas", read)).toBe(false);

    await setOptOut(sql, kit.id, true, chat);
    expect((await repoSnapshots(sql, [atlas.id])).size).toBe(0);
    expect(await sql`SELECT 1 FROM project_repos WHERE project_id = ${atlas.id}`).toHaveLength(0);
  });

  it("waits for an author stopping the collecting at that moment, and then keeps nothing", async () => {
    const chat = await newChat();
    const kit = await member(chat, "Kit");
    const atlas = await project(chat, kit, "Atlas", "https://github.com/kit/atlas");
    const read = await readOf(atlasRoutes());
    let saving: Promise<boolean> | undefined;
    let settled = false;
    await sql.begin(async (tx) => {
      await tx`UPDATE members SET opted_out = true WHERE chat_id = ${chat} AND user_id = ${kit.id}`;
      saving = saveRepoRead(sql, atlas.id, "https://github.com/kit/atlas", read).finally(() => {
        settled = true;
      });
      await sleep(150);
      expect(settled).toBe(false);
      await tx`DELETE FROM project_repos WHERE project_id = ${atlas.id}`;
    });
    expect(await saving).toBe(false);
    expect(await sql`SELECT 1 FROM project_repos WHERE project_id = ${atlas.id}`).toHaveLength(0);
  });

  it("runs a round an hour, never two at once, waits out the limit and stops mid-call", async () => {
    const chat = await newChat();
    const kit = await member(chat, "Kit");
    await project(chat, kit, "Atlas", "https://github.com/kit/atlas");
    await project(chat, kit, "Orbit", "https://github.com/kit/orbit");

    // A slow GitHub, a round due every 20 ms: one call at a time.
    let running = 0;
    let most = 0;
    let calls = 0;
    const slow = (async (input: string | URL | Request) => {
      running += 1;
      calls += 1;
      most = Math.max(most, running);
      await sleep(60);
      running -= 1;
      return fakeGithub(atlasRoutes())
        .fetchImpl(input);
    }) as typeof fetch;
    const stopSlow = startRepoWatch({ sql, checkHours: 24, fetch: slow, everyMs: 20, startDelayMs: 0, log: () => {} });
    await until(() => calls >= 4);
    await stopSlow();
    expect(most).toBe(1);

    // The limit is spent for an hour: later rounds ask nothing.
    await sql`DELETE FROM project_repos`;
    let asked = 0;
    const spent = (async () => {
      asked += 1;
      return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600) },
      });
    }) as typeof fetch;
    const stopSpent = startRepoWatch({ sql, checkHours: 24, fetch: spent, everyMs: 20, startDelayMs: 0, log: () => {} });
    await sleep(200);
    await stopSpent();
    expect(asked).toBe(1);

    // GitHub out of reach: one line a round, nothing more.
    const offlineLines: string[] = [];
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const stopOffline = startRepoWatch({ sql, checkHours: 24, fetch: offline, everyMs: 60_000, startDelayMs: 0, log: (line) => offlineLines.push(line) });
    await until(() => offlineLines.length > 0);
    await stopOffline();
    expect(offlineLines).toEqual(["[repos] GitHub could not be reached: fetch failed; the next round tries again"]);

    // A stop cancels the call under way, and nothing is kept.
    let started = false;
    const hanging = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        started = true;
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as typeof fetch;
    const lines: string[] = [];
    const stopHanging = startRepoWatch({ sql, checkHours: 24, fetch: hanging, everyMs: 60_000, startDelayMs: 0, log: (line) => lines.push(line) });
    await until(() => started);
    const stoppedAt = Date.now();
    await stopHanging();
    expect(Date.now() - stoppedAt).toBeLessThan(1000);
    expect(await sql`SELECT 1 FROM project_repos`).toHaveLength(0);
    expect(lines).toEqual([]);
  });

  it("shows what it read in the answers, on the chat's card of the project and on its page in the Mini App", async () => {
    const chat = await newChat();
    const kit = await member(chat, "Kit", 9990);
    const atlas = await project(chat, kit, "Atlas", "https://github.com/kit/atlas");
    await saveRepoRead(sql, atlas.id, "https://github.com/kit/atlas", await readOf(atlasRoutes()));
    // Said "in progress" long ago, and quiet on GitHub for over a month since.
    await sql`UPDATE projects SET created_at = now() - interval '200 days' WHERE id = ${atlas.id}`;
    await sql`UPDATE change_log SET at = now() - interval '200 days' WHERE entity = 'project' AND entity_id = ${atlas.id}`;
    await sql`UPDATE project_repos SET committed_at = now() - interval '40 days 1 hour' WHERE project_id = ${atlas.id}`;

    const from = { id: kit.tg_id!, is_bot: false, first_name: "Kit" };
    const asking = (text: string): Question => ({
      chatId: chat,
      chatTitle: "Hive",
      from,
      me,
      message: { message_id: ++nextMsgId, date: Math.floor(Date.now() / 1000), chat: { id: chat, type: "supergroup", title: "Hive" }, from, text } as unknown as Message,
    });
    const contextOf = async (text: string) =>
      promptText(await buildReplyContext(sql, asking(text), { timezone: "UTC", model: "claude-opus-5-5", ownerTgIds: [], recentAnswers: [], insultMotif: "the scrolls are sealed" }));
    const context = await contextOf("@waggle_test_bot что нового у Atlas?");
    const catalog = /<projects[^>]*>\n([\s\S]*?)\n<\/projects>/.exec(context)![1]!;
    expect(catalog).toMatch(
      /Atlas — in progress.*github, read .*: last commit .*, latest release v0\.2\.0-beta \(a pre-release\) on 19 Nov( 2026)?, no commit for 40 days while the status says in progress: it looks paused, but the status is its authors' word/,
    );
    const details = /<project_details>\n([\s\S]*?)\n<\/project_details>/.exec(context)![1]!;
    expect(details).toContain("Latest commits in kit/atlas on GitHub, newest first, bots' left out");
    expect(details).toMatch(/20 Nov( 2026)? “Fix the login crash”; 18 Nov( 2026)? “Add very/);

    const listed = (await getProjectBySlug(sql, chat, "atlas"))!;
    const snapshot = (await repoSnapshots(sql, [atlas.id])).get(atlas.id)!;
    const card = projectCard(listed, chat, { repo: snapshot, hint: repoHint(listed.status, null, snapshot), timeZone: "UTC" });
    expect(card).toContain("💻 GitHub: last commit");
    expect(card).toMatch(/release v0\.2\.0-beta \(pre-release\), 19 Nov( 2026)?/);
    expect(card).toContain("💤 Looks paused: no commits for 40 days, though it says in progress");
    expect(card).toContain(`<a href="https://github.com/kit/atlas/commit/${"a".repeat(40)}">Fix the login crash</a>`);
    const lastYear = projectCard(listed, chat, { repo: { ...snapshot, committed_at: new Date("2024-03-03T12:00:00Z") }, hint: null, timeZone: "UTC" });
    expect(lastYear).toContain("last commit 3 Mar 2024");

    const app = createApi({ sql, botToken: TOKEN, adminTgIds: [], isMember: async () => true, webDistDir: "web/dist" });
    const headers = {
      authorization: `tma ${signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: kit.tg_id, first_name: "Kit" }) }, TOKEN)}`,
      "x-chat-id": `c${Math.abs(chat)}`,
    };
    const pageOf = async (slug: string) => (await (await app.request(`/api/projects/${slug}`, { headers })).json()) as { repo: Record<string, unknown> | null; repo_hint: unknown };
    const page = await pageOf("atlas");
    expect(page.repo_hint).toEqual({ kind: "quiet", days: 40 });
    expect(page.repo).toMatchObject({
      full_name: "kit/atlas",
      url: "https://github.com/kit/atlas",
      release: { tag: "v0.2.0-beta", prerelease: true },
      commits: [{ title: "Fix the login crash", url: `https://github.com/kit/atlas/commit/${"a".repeat(40)}` }, {}],
    });

    // Paused for weeks, then a commit of its own three days before the reading: it looks active again.
    const nova = await project(chat, kit, "Nova", "https://github.com/kit/nova");
    await updateProject(sql, { chatId: chat, projectId: nova.id, status: "paused", source: "user", actorUserId: kit.id });
    await sql`UPDATE change_log SET at = now() - interval '20 days' WHERE entity = 'project' AND entity_id = ${nova.id}`;
    await saveRepoRead(sql, nova.id, "https://github.com/kit/nova", await readOf(atlasRoutes("kit/nova"), { owner: "kit", name: "nova" }));
    await sql`UPDATE project_repos SET committed_at = now() - interval '3 days 1 hour' WHERE project_id = ${nova.id}`;
    expect((await pageOf("nova")).repo_hint).toEqual({ kind: "active_again", days: 3 });

    // A project far down the rating still gets its commits when the question names it.
    for (let index = 0; index < 61; index += 1) await project(chat, kit, `Filler ${index}`, null);
    await sql`UPDATE projects SET last_activity_at = now() - interval '300 days', created_at = now() - interval '300 days' WHERE id = ${atlas.id}`;
    const far = await contextOf("@waggle_test_bot что нового у Atlas?");
    expect(/<projects[^>]*>\n([\s\S]*?)\n<\/projects>/.exec(far)![1]).not.toContain("Atlas —");
    expect(/<project_details>\n([\s\S]*?)\n<\/project_details>/.exec(far)![1]).toContain("Latest commits in kit/atlas on GitHub");
  });
});
