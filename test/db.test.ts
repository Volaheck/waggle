import { readFile } from "node:fs/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/api/server.js";
import { signInitData } from "../src/api/init-data.js";
import { createSql, migrate, type Sql } from "../src/core/db.js";
import { normalizeStacks, proposeFact, rejectFact, visibleFacts, whoKnows } from "../src/core/facts.js";
import { mergeSeedUser } from "../src/core/merge.js";
import { saveMessage } from "../src/core/messages.js";
import { listProjects, setVote, upsertProject } from "../src/core/projects.js";
import { catchupFor } from "../src/core/chronicle.js";
import { attachLegacyData, chatsOfUser, LEGACY_CHAT_ID, registerChat, setChatStatus } from "../src/core/chats.js";
import { resolveUser, type Person } from "../src/core/users.js";
import { importSeed, parseSeed } from "../src/scripts/seed.js";
import { applyConsolidation, loadConsolidationInput } from "../src/worker/consolidate.js";
import { applyExtraction, buildExtractionPrompt, runExtractionPass, type ExtractionResult } from "../src/worker/extract.js";
import { NOTES_SYSTEM_PROMPT } from "../src/worker/notes-extract.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const CHAT_ID = -1001234567890;
const OTHER_CHAT_ID = -1009876543210;
const TOKEN = "123456:TEST-TOKEN";

describe.skipIf(!DATABASE_URL)("with postgres", () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = createSql(DATABASE_URL!);
    await sql`DROP SCHEMA public CASCADE`;
    await sql`CREATE SCHEMA public`;
    await migrate(sql);
    await registerChat(sql, CHAT_ID, "Test chat", null);
    await setChatStatus(sql, CHAT_ID, "approved", null);
    const people = JSON.parse(await readFile("seed/example-people.json", "utf8"));
    const projects = JSON.parse(await readFile("seed/example-projects.json", "utf8"));
    await importSeed(sql, CHAT_ID, people, projects);
  });

  afterAll(async () => {
    await sql?.end();
  });

  it("imports seed idempotently", async () => {
    const before = await sql<{ facts: number; projects: number; users: number }[]>`
      SELECT (SELECT count(*)::int FROM facts) AS facts, (SELECT count(*)::int FROM projects) AS projects, (SELECT count(*)::int FROM users) AS users`;
    const people = JSON.parse(await readFile("seed/example-people.json", "utf8"));
    const projects = JSON.parse(await readFile("seed/example-projects.json", "utf8"));
    await importSeed(sql, CHAT_ID, people, projects);
    const after = await sql<{ facts: number; projects: number; users: number }[]>`
      SELECT (SELECT count(*)::int FROM facts) AS facts, (SELECT count(*)::int FROM projects) AS projects, (SELECT count(*)::int FROM users) AS users`;
    expect(after[0]).toEqual(before[0]);
    expect(before[0]!.projects).toBe(4);
    expect(before[0]!.users).toBe(5);
  });

  it("reads the Russian statuses of older seed files as today's codes", async () => {
    const SEED_CHAT_ID = -1005550000001;
    const legacy = ["идея", "в работе", "запущен", "на паузе", "заброшен"].map((status, index) => ({
      slug: `legacy-${index}`, name: `Legacy ${index}`, status, links: {}, authors: [],
    }));
    const { people, projects } = parseSeed([], legacy);
    expect(projects.map((project) => project.status)).toEqual(["idea", "in_progress", "launched", "paused", "abandoned"]);
    await importSeed(sql, SEED_CHAT_ID, people, projects);
    const stored = await sql<{ status: string }[]>`SELECT status FROM projects WHERE chat_id = ${SEED_CHAT_ID} ORDER BY slug`;
    expect(stored.map((row) => row.status)).toEqual(["idea", "in_progress", "launched", "paused", "abandoned"]);
    expect(() => parseSeed([], [{ ...legacy[0], status: "done" }])).toThrow();
  });

  it("links a seeded card when the real account shows up", async () => {
    const user = await resolveUser(sql, { id: 1001, username: "anna_dev", first_name: "Аня", last_name: "П." }, [1001], CHAT_ID);
    expect(user.display_name).toBe("Аня П.");
    expect(user.is_admin).toBe(true);
    const facts = await visibleFacts(sql, CHAT_ID, user.id);
    expect(facts.some((fact) => fact.value === "Swift")).toBe(true);
  });

  it("merges a seed card that did not auto-link", async () => {
    const real = await resolveUser(sql, { id: 2002, first_name: "Миша", username: "mike_real" }, [], CHAT_ID);
    const [seed] = await sql<{ id: number }[]>`SELECT id FROM users WHERE display_name = 'Mike' AND tg_id IS NULL`;
    const topic = async (userIds: number[]) =>
      (await sql<{ id: number }[]>`
        INSERT INTO chronicle (run_id, period_from, period_to, title, summary, user_ids, chat_id)
        VALUES (0, now(), now(), 'Topic', 'Summary', ${userIds}::int[], ${CHAT_ID}) RETURNING id`)[0]!.id;
    const both = await topic([seed!.id, 424242, real.id]);
    const cardOnly = await topic([424242, seed!.id]);
    await mergeSeedUser(sql, seed!.id, real.id, real.id);
    const participants = async (id: number) => (await sql<{ user_ids: number[] }[]>`SELECT user_ids FROM chronicle WHERE id = ${id}`)[0]!.user_ids;
    expect(await participants(both)).toEqual([real.id, 424242]);
    expect(await participants(cardOnly)).toEqual([424242, real.id]);
    const facts = await visibleFacts(sql, CHAT_ID, real.id);
    expect(facts.some((fact) => fact.kind === "role")).toBe(true);
    const [pixelChess] = await sql<{ user_id: number }[]>`SELECT pm.user_id FROM project_members pm JOIN projects p ON p.id = pm.project_id WHERE p.slug = 'pixel-chess'`;
    expect(pixelChess!.user_id).toBe(real.id);
  });

  it("never brings back a rejected fact and skips forbidden topics", async () => {
    const user = await resolveUser(sql, { id: 3003, first_name: "Тест" }, [], CHAT_ID);
    const fact = (chatId: number, value: string, kind: "stack" | "interest" = "stack") =>
      proposeFact(sql, { chatId, userId: user.id, kind, value, confidence: 0.9, sourceMsgIds: [1], source: "llm" });
    expect(await fact(CHAT_ID, "Kotlin")).toBe("added");
    const [stored] = await visibleFacts(sql, CHAT_ID, user.id);
    await rejectFact(sql, stored!.id, user.id, "user");
    expect(await fact(CHAT_ID, "kotlin")).toBe("skipped_rejected");
    expect(await fact(CHAT_ID, "обсуждает политику", "interest")).toBe("skipped_forbidden");
    // A card is per chat: a rejection in one chat says nothing about another.
    await resolveUser(sql, { id: 3003, first_name: "Тест" }, [], OTHER_CHAT_ID);
    expect(await fact(OTHER_CHAT_ID, "Kotlin")).toBe("added");
    expect((await visibleFacts(sql, CHAT_ID, user.id)).length).toBe(0);
  });

  it("runs a pass: chronicle, facts, project signals with anti-spam", async () => {
    const author = await resolveUser(sql, { id: 1001, username: "anna_dev", first_name: "Аня", last_name: "П." }, [], CHAT_ID);
    const fan = await resolveUser(sql, { id: 4004, username: "fan", first_name: "Фанат" }, [], CHAT_ID);
    const base = Date.now() - 60 * 60 * 1000;
    const texts: [number, number, string][] = [
      [9001, fan.id, "Поставил Atlas, теперь трекаю все привычки, очень удобно"],
      [9002, author.id, "Выкатила Atlas 0.2 с виджетами"],
      [9003, fan.id, "atlas atlas atlas топ"],
      [9004, fan.id, "кстати, перешёл на Zed вместо VS Code"],
    ];
    for (const [msgId, userId, text] of texts) {
      await saveMessage(sql, { chatId: CHAT_ID, msgId, userId, sentAt: new Date(base + msgId), text, replyToMsgId: null, isForward: false, forwardSource: null, mediaType: null });
    }
    const fakeResult: ExtractionResult = {
      topics: [{ title: "Релиз Atlas 0.2", summary: "Аня выкатила Atlas 0.2, Фанат трекает в нём привычки.", kind: "project", importance: 5, project: "atlas", msg_ids: [9002, 9001] }],
      facts_add: [
        { person: `u${fan.id}`, kind: "stack", value: "Zed", confidence: 0.9, source_msg_ids: [9004] },
        { person: `u${fan.id}`, kind: "stack", value: "Zed (перешёл с VS Code)", confidence: 0.9, source_msg_ids: [9004] },
      ],
      facts_update: [],
      projects: [],
      project_renames: [],
      project_signals: [
        { project: "atlas", person: `u${fan.id}`, kind: "usage", impact: 4, note: "Фанат трекает в Atlas все привычки", source_msg_ids: [9001] },
        { project: "atlas", person: `u${fan.id}`, kind: "usage", impact: 5, note: "дубль", source_msg_ids: [9003] },
        { project: "atlas", person: `u${author.id}`, kind: "praise", impact: 5, note: "автор хвалит сам себя", source_msg_ids: [9002] },
        { project: "atlas", person: `u${author.id}`, kind: "milestone", impact: 3, note: "Вышел Atlas 0.2 с виджетами", source_msg_ids: [9002] },
      ],
    };
    let prompt = "";
    const fakeAnthropic = {
      messages: {
        // The chronicle and the cards come from the first call; the second one, for the private notes, finds none.
        stream: (params: { system: string; messages: { content: string }[] }) => {
          const notesCall = params.system === NOTES_SYSTEM_PROMPT;
          if (!notesCall) prompt = params.messages[0]!.content;
          return {
            finalMessage: async () => ({
              stop_reason: "end_turn",
              stop_details: null,
              content: [{ type: "text", text: JSON.stringify(notesCall ? { notes: [], aliases: [] } : fakeResult) }],
              usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            }),
          };
        },
      },
    } as unknown as Anthropic;

    const deps = { sql, anthropic: fakeAnthropic, chatId: CHAT_ID, chatBudgetUsd: 2, config: { EXTRACTION_MODEL: "claude-haiku-5-5", MONTHLY_LLM_BUDGET_USD: 5 } };
    const stats = await runExtractionPass(deps);
    expect(stats.calls).toBe(1);
    expect(stats.notesCalls).toBe(1);
    expect(stats.notesFailures).toEqual([]);
    expect(stats.topics).toBe(1);
    expect(stats.signals).toBe(2);
    expect(stats.factsAdded).toBe(1);
    expect(stats.factsReinforced).toBe(1);
    const [topic] = await sql<{ importance: number; slug: string | null }[]>`
      SELECT c.importance, p.slug FROM chronicle c LEFT JOIN projects p ON p.id = c.project_id WHERE c.title = 'Релиз Atlas 0.2'`;
    expect(topic!.importance).toBe(5);
    expect(topic!.slug).toBe("atlas");
    expect(prompt).toContain("Поставил Atlas");

    const [pending] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM messages WHERE chat_id = ${CHAT_ID} AND extracted_at IS NULL`;
    expect(pending!.count).toBe(0);

    const second = await runExtractionPass(deps);
    expect(second.calls).toBe(0);
    const [usage] = await sql<{ chat_id: number }[]>`SELECT chat_id FROM llm_usage ORDER BY id DESC LIMIT 1`;
    expect(usage!.chat_id).toBe(CHAT_ID);

    const projects = await listProjects(sql, CHAT_ID);
    const atlas = projects.find((project) => project.slug === "atlas")!;
    expect(atlas.signals_count).toBe(2);
    expect(atlas.score).toBeGreaterThan(0);
    expect(projects[0]!.slug).toBe("atlas");

    expect(await setVote(sql, atlas.id, author.id, true)).toBe("own_project");
    expect(await setVote(sql, atlas.id, fan.id, true)).toBe("ok");
    expect(await listProjects(sql, OTHER_CHAT_ID)).toEqual([]);
    const afterVote = (await listProjects(sql, CHAT_ID)).find((project) => project.slug === "atlas")!;
    expect(afterVote.score).toBe(atlas.score + 5);
  });

  it("whoknows and catchup work without the LLM", async () => {
    const experts = await whoKnows(sql, CHAT_ID, "swift");
    expect(experts.some((person) => person.username === "anna_dev")).toBe(true);
    expect(await whoKnows(sql, OTHER_CHAT_ID, "swift")).toEqual([]);

    const fan = await resolveUser(sql, { id: 4004, username: "fan", first_name: "Фанат" }, [], CHAT_ID);
    const [member] = await sql<Person[]>`SELECT u.*, m.* FROM users u JOIN members m ON m.user_id = u.id WHERE m.chat_id = ${CHAT_ID} AND u.id = ${fan.id}`;
    const catchup = await catchupFor(sql, CHAT_ID, { ...member!, last_message_at: new Date(Date.now() - 3 * 3_600_000) }, 5);
    expect(catchup.entries.length).toBeGreaterThan(0);
    expect(catchup.unprocessed.count).toBe(0);
  });

  it("builds a prompt that lists participants with fact ids", async () => {
    const [user] = await sql<{ id: number }[]>`SELECT id FROM users WHERE username = 'anna_dev'`;
    const prompt = buildExtractionPrompt({
      chatId: CHAT_ID,
      batch: [{ chat_id: CHAT_ID, msg_id: 1, user_id: user!.id, sent_at: new Date(), text: "привет", reply_to_msg_id: null, is_forward: false, forward_source: null, media_type: null }],
      context: [],
      users: await sql<Person[]>`SELECT u.*, m.* FROM users u JOIN members m ON m.user_id = u.id WHERE m.chat_id = ${CHAT_ID}`,
      facts: await sql`SELECT * FROM facts WHERE chat_id = ${CHAT_ID} AND user_id = ${user!.id}`,
      projects: [],
      recentTopics: [],
    });
    expect(prompt).toMatch(/\[f\d+\] stack: Swift/);
    expect(prompt).toContain("<new_messages>");
    void applyExtraction;
  });

  it("serves the Mini App API only to members with valid initData", async () => {
    const app = createApi({ sql, botToken: TOKEN, adminTgIds: [], isMember: async (chatId, id) => chatId === CHAT_ID && id === 1001, webDistDir: "web/dist" });
    const auth = (id: number) => ({
      authorization: `tma ${signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, first_name: "X" }) }, TOKEN)}`,
    });
    expect((await app.request("/api/people")).status).toBe(401);
    expect((await app.request("/api/people", { headers: auth(5005) })).status).toBe(403);
    const people = await app.request("/api/people", { headers: auth(1001) });
    expect(people.status).toBe(200);
    const body = (await people.json()) as { people: { display_name: string }[] };
    expect(body.people.length).toBeGreaterThan(5);
    const top = (await (await app.request("/api/projects", { headers: auth(1001) })).json()) as { projects: { slug: string }[] };
    expect(top.projects[0]!.slug).toBe("atlas");
    // Asking for a chat the person is not in is refused even with valid initData.
    const foreign = await app.request("/api/people", { headers: { ...auth(1001), "x-chat-id": `c${Math.abs(OTHER_CHAT_ID)}` } });
    expect(foreign.status).toBe(403);
    const chats = (await (await app.request("/api/chats", { headers: auth(1001) })).json()) as { chats: { key: string }[]; current: string };
    expect(chats.chats.map((chat) => chat.key)).toEqual([`c${Math.abs(CHAT_ID)}`]);
  });

  it("asks which chat when a person is in several and none is picked", async () => {
    await registerChat(sql, OTHER_CHAT_ID, "Other chat", null);
    await setChatStatus(sql, OTHER_CHAT_ID, "approved", null);
    const user = await resolveUser(sql, { id: 6006, first_name: "Двойной" }, [], CHAT_ID);
    await resolveUser(sql, { id: 6006, first_name: "Двойной" }, [], OTHER_CHAT_ID);
    expect((await chatsOfUser(sql, user.id)).length).toBe(2);
    const app = createApi({ sql, botToken: TOKEN, adminTgIds: [], isMember: async () => true, webDistDir: "web/dist" });
    const headers = { authorization: `tma ${signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 6006, first_name: "Двойной" }) }, TOKEN)}` };
    expect((await app.request("/api/people", { headers })).status).toBe(409);
    const picked = await app.request("/api/people", { headers: { ...headers, "x-chat-id": `c${Math.abs(OTHER_CHAT_ID)}` } });
    expect(picked.status).toBe(200);
    // The pick is remembered for the next launch.
    expect((await app.request("/api/people", { headers })).status).toBe(200);
  });

  it("attaches imported history to a chat once an owner approves it, merging what collides", async () => {
    const legacyUser = await resolveUser(sql, { id: 5050, first_name: "Импорт" }, [], LEGACY_CHAT_ID);
    await proposeFact(sql, { chatId: LEGACY_CHAT_ID, userId: legacyUser.id, kind: "stack", value: "Elixir", confidence: 0.9, sourceMsgIds: [1], source: "seed" });
    await sql`INSERT INTO rejected_facts (chat_id, user_id, kind, value_norm) VALUES (${LEGACY_CHAT_ID}, ${legacyUser.id}, 'stack', 'cobol')`;
    await saveMessage(sql, { chatId: LEGACY_CHAT_ID, msgId: 77, userId: legacyUser.id, sentAt: new Date(), text: "старое сообщение https://pulse.example.com", replyToMsgId: null, isForward: false, forwardSource: null, mediaType: null });
    // The chat already has the imported slug, as the chronicler or /addproject can create between approval and attach.
    const [own] = await sql<{ id: number }[]>`INSERT INTO projects (chat_id, slug, name) VALUES (${OTHER_CHAT_ID}, 'pulse', 'Pulse') RETURNING id`;
    const [imported] = await sql<{ id: number }[]>`INSERT INTO projects (chat_id, slug, name) VALUES (${LEGACY_CHAT_ID}, 'pulse', 'Pulse') RETURNING id`;
    await sql`INSERT INTO project_members (project_id, user_id) VALUES (${imported!.id}, ${legacyUser.id})`;
    await sql`INSERT INTO project_signals (project_id, user_id, kind, impact, note, happened_at) VALUES (${imported!.id}, ${legacyUser.id}, 'milestone', 5, 'Pulse launched', now())`;
    const [topic] = await sql<{ id: number }[]>`
      INSERT INTO chronicle (chat_id, run_id, period_from, period_to, title, summary, project_id, msg_ids)
      VALUES (${LEGACY_CHAT_ID}, 0, now(), now(), 'Pulse launched', 'Импорт запустил Pulse.', ${imported!.id}, '{77}') RETURNING id`;

    const moved = await attachLegacyData(sql, OTHER_CHAT_ID);
    expect(moved).toMatchObject({ messages: 1, projects: 1, projectsMerged: 1, topics: 1 });
    expect((await sql`SELECT 1 FROM messages WHERE chat_id = ${OTHER_CHAT_ID} AND msg_id = 77`).length).toBe(1);
    expect((await visibleFacts(sql, OTHER_CHAT_ID, legacyUser.id)).map((fact) => fact.value)).toEqual(["Elixir"]);
    expect(await proposeFact(sql, { chatId: OTHER_CHAT_ID, userId: legacyUser.id, kind: "stack", value: "COBOL", confidence: 0.9, sourceMsgIds: [1], source: "llm" })).toBe("skipped_rejected");
    const [pulse] = await sql<{ authors: number; signals: number }[]>`
      SELECT (SELECT count(*)::int FROM project_members WHERE project_id = ${own!.id}) AS authors,
             (SELECT count(*)::int FROM project_signals WHERE project_id = ${own!.id}) AS signals`;
    expect(pulse).toEqual({ authors: 1, signals: 1 });
    expect((await sql<{ chat_id: number; project_id: number }[]>`SELECT chat_id, project_id FROM chronicle WHERE id = ${topic!.id}`)[0]).toEqual({ chat_id: OTHER_CHAT_ID, project_id: own!.id });
    const [left] = await sql<{ count: string }[]>`
      SELECT (SELECT count(*) FROM messages WHERE chat_id = ${LEGACY_CHAT_ID}) + (SELECT count(*) FROM facts WHERE chat_id = ${LEGACY_CHAT_ID})
           + (SELECT count(*) FROM rejected_facts WHERE chat_id = ${LEGACY_CHAT_ID}) + (SELECT count(*) FROM projects WHERE chat_id = ${LEGACY_CHAT_ID})
           + (SELECT count(*) FROM chronicle WHERE chat_id = ${LEGACY_CHAT_ID}) + (SELECT count(*) FROM members WHERE chat_id = ${LEGACY_CHAT_ID}) AS count`;
    expect(Number(left!.count)).toBe(0);
  });
});

describe.skipIf(!DATABASE_URL)("dedupe and clean-up", () => {
  let sql: Sql;
  beforeAll(() => {
    sql = createSql(DATABASE_URL!);
  });
  afterAll(async () => {
    await sql?.end();
  });

  it("does not add near-duplicate facts and skips links of own projects", async () => {
    const user = await resolveUser(sql, { id: 7007, first_name: "Дубль" }, [], CHAT_ID);
    const fact = (kind: "stack" | "link", value: string) => proposeFact(sql, { chatId: CHAT_ID, userId: user.id, kind, value, confidence: 0.9, sourceMsgIds: [1], source: "llm" });
    expect(await fact("stack", "Codex (тариф Max)")).toBe("added");
    expect(await fact("stack", "Codex (активно пользовался)")).toBe("reinforced");
    expect(await fact("stack", "Claude Code")).toBe("added");
    const { project } = await upsertProject(sql, { chatId: CHAT_ID, name: "Dupe Site", links: { site: "https://dupe.example.com/" }, authorIds: [user.id], sourceMsgIds: [], source: "user" });
    expect(await fact("link", "https://dupe.example.com")).toBe("skipped_existing");
    const again = await upsertProject(sql, { chatId: CHAT_ID, name: "Сайт Dupe Site", authorIds: [user.id], sourceMsgIds: [], source: "llm" });
    expect(again.project.id).toBe(project.id);
  });

  it("normalizes stacks: splits combined facts and folds one vendor's tools without losing anything", async () => {
    const user = await resolveUser(sql, { id: 9009, first_name: "Стек" }, [], CHAT_ID);
    for (const value of ["GPT-6", "Codex (тариф Max)", "Vercel, Scaleway", "Claude Code (вместе с Codex)"]) {
      await sql`
        INSERT INTO facts (chat_id, user_id, kind, value, value_norm, confidence, status)
        VALUES (${CHAT_ID}, ${user.id}, 'stack', ${value}, ${value.toLowerCase()}, 0.9, 'auto')`;
    }
    await normalizeStacks(sql, CHAT_ID);
    const stack = (await visibleFacts(sql, CHAT_ID, user.id)).filter((fact) => fact.kind === "stack").map((fact) => fact.value).sort();
    expect(stack).toEqual(["Claude", "GPT / Codex", "Scaleway", "Vercel"]);
    expect(await proposeFact(sql, { chatId: CHAT_ID, userId: user.id, kind: "stack", value: "ChatGPT", confidence: 0.9, sourceMsgIds: [1], source: "llm" })).toBe("reinforced");
  });

  it("consolidation merges facts and projects but never touches manual facts", async () => {
    const user = await resolveUser(sql, { id: 8008, first_name: "Уборка" }, [], CHAT_ID);
    const base = { chatId: CHAT_ID, userId: user.id, confidence: 0.9, source: "llm" as const };
    await proposeFact(sql, { ...base, kind: "role", value: "бэкенд", sourceMsgIds: [1] });
    await proposeFact(sql, { ...base, kind: "role", value: "тимлид", sourceMsgIds: [2] });
    await proposeFact(sql, { ...base, kind: "interest", value: "шахматы", confidence: 1, sourceMsgIds: [], source: "user" });
    await upsertProject(sql, { chatId: CHAT_ID, slug: "dup-a", name: "Dup A", authorIds: [user.id], sourceMsgIds: [], source: "llm" });
    await upsertProject(sql, { chatId: CHAT_ID, slug: "dup-b", name: "Другое имя B", authorIds: [user.id], sourceMsgIds: [], source: "llm" });
    const input = await loadConsolidationInput(sql, CHAT_ID);
    const mine = input.facts.filter((fact) => fact.user_id === user.id);
    const roles = mine.filter((fact) => fact.kind === "role").map((fact) => fact.id);
    const manual = mine.find((fact) => fact.kind === "interest")!;
    const stats = await applyConsolidation(sql, input, {
      fact_merges: [{ fact_ids: roles, value: "бэкенд-тимлид" }],
      fact_drops: [{ fact_id: manual.id }],
      project_merges: [{ into: "dup-a", from: ["dup-b"] }],
      project_updates: [],
    });
    expect(stats.factsMerged).toBe(2);
    expect(stats.factsDropped).toBe(0);
    expect(stats.projectsMerged).toBe(1);
    const facts = await visibleFacts(sql, CHAT_ID, user.id);
    expect(facts.filter((fact) => fact.kind === "role").map((fact) => fact.value)).toEqual(["бэкенд-тимлид"]);
    expect(facts.some((fact) => fact.value === "шахматы")).toBe(true);
    const [hidden] = await sql<{ hidden: boolean }[]>`SELECT hidden FROM projects WHERE slug = 'dup-b'`;
    expect(hidden!.hidden).toBe(true);
  });
});
