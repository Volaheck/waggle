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
import { resolveUser } from "../src/core/users.js";
import { importSeed } from "../src/scripts/seed.js";
import { applyConsolidation, loadConsolidationInput } from "../src/worker/consolidate.js";
import { applyExtraction, buildExtractionPrompt, runExtractionPass, type ExtractionResult } from "../src/worker/extract.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const CHAT_ID = -1001234567890;
const TOKEN = "123456:TEST-TOKEN";

describe.skipIf(!DATABASE_URL)("with postgres", () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = createSql(DATABASE_URL!);
    await sql`DROP SCHEMA public CASCADE`;
    await sql`CREATE SCHEMA public`;
    await migrate(sql);
    const people = JSON.parse(await readFile("seed/example-people.json", "utf8"));
    const projects = JSON.parse(await readFile("seed/example-projects.json", "utf8"));
    await importSeed(sql, people, projects);
  });

  afterAll(async () => {
    await sql?.end();
  });

  it("imports seed idempotently", async () => {
    const before = await sql<{ facts: number; projects: number; users: number }[]>`
      SELECT (SELECT count(*)::int FROM facts) AS facts, (SELECT count(*)::int FROM projects) AS projects, (SELECT count(*)::int FROM users) AS users`;
    const people = JSON.parse(await readFile("seed/example-people.json", "utf8"));
    const projects = JSON.parse(await readFile("seed/example-projects.json", "utf8"));
    await importSeed(sql, people, projects);
    const after = await sql<{ facts: number; projects: number; users: number }[]>`
      SELECT (SELECT count(*)::int FROM facts) AS facts, (SELECT count(*)::int FROM projects) AS projects, (SELECT count(*)::int FROM users) AS users`;
    expect(after[0]).toEqual(before[0]);
    expect(before[0]!.projects).toBe(4);
    expect(before[0]!.users).toBe(5);
  });

  it("links a seeded card when the real account shows up", async () => {
    const user = await resolveUser(sql, { id: 1001, username: "anna_dev", first_name: "Аня", last_name: "П." }, [1001]);
    expect(user.display_name).toBe("Аня П.");
    expect(user.is_admin).toBe(true);
    const facts = await visibleFacts(sql, user.id);
    expect(facts.some((fact) => fact.value === "Swift")).toBe(true);
  });

  it("merges a seed card that did not auto-link", async () => {
    const real = await resolveUser(sql, { id: 2002, first_name: "Миша", username: "mike_real" }, []);
    const [seed] = await sql<{ id: number }[]>`SELECT id FROM users WHERE display_name = 'Mike' AND tg_id IS NULL`;
    await mergeSeedUser(sql, seed!.id, real.id, real.id);
    const facts = await visibleFacts(sql, real.id);
    expect(facts.some((fact) => fact.kind === "role")).toBe(true);
    const [pixelChess] = await sql<{ user_id: number }[]>`SELECT pm.user_id FROM project_members pm JOIN projects p ON p.id = pm.project_id WHERE p.slug = 'pixel-chess'`;
    expect(pixelChess!.user_id).toBe(real.id);
  });

  it("never brings back a rejected fact and skips forbidden topics", async () => {
    const user = await resolveUser(sql, { id: 3003, first_name: "Тест" }, []);
    expect(await proposeFact(sql, { userId: user.id, kind: "stack", value: "Kotlin", confidence: 0.9, sourceMsgIds: [1], source: "llm" })).toBe("added");
    const [fact] = await visibleFacts(sql, user.id);
    await rejectFact(sql, fact!.id, user.id, "user");
    expect(await proposeFact(sql, { userId: user.id, kind: "stack", value: "kotlin", confidence: 0.9, sourceMsgIds: [2], source: "llm" })).toBe("skipped_rejected");
    expect(await proposeFact(sql, { userId: user.id, kind: "interest", value: "обсуждает политику", confidence: 0.9, sourceMsgIds: [3], source: "llm" })).toBe("skipped_forbidden");
  });

  it("runs a pass: chronicle, facts, project signals with anti-spam", async () => {
    const author = await resolveUser(sql, { id: 1001, username: "anna_dev", first_name: "Аня", last_name: "П." }, []);
    const fan = await resolveUser(sql, { id: 4004, username: "fan", first_name: "Фанат" }, []);
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
      facts_outdated: [],
      projects: [],
      project_signals: [
        { project: "atlas", person: `u${fan.id}`, kind: "usage", impact: 4, note: "Фанат трекает в Atlas все привычки", source_msg_ids: [9001] },
        { project: "atlas", person: `u${fan.id}`, kind: "usage", impact: 5, note: "дубль", source_msg_ids: [9003] },
        { project: "atlas", person: `u${author.id}`, kind: "praise", impact: 5, note: "автор хвалит сам себя", source_msg_ids: [9002] },
        { project: "atlas", person: `u${author.id}`, kind: "milestone", impact: 3, note: "Вышел Atlas 0.2 с виджетами", source_msg_ids: [9002] },
      ],
      taglines: [],
    };
    let prompt = "";
    const fakeAnthropic = {
      messages: {
        stream: (params: { messages: { content: string }[] }) => {
          prompt = params.messages[0]!.content;
          return {
            finalMessage: async () => ({
              stop_reason: "end_turn",
              stop_details: null,
              content: [{ type: "text", text: JSON.stringify(fakeResult) }],
              usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            }),
          };
        },
      },
    } as unknown as Anthropic;

    const stats = await runExtractionPass({ sql, anthropic: fakeAnthropic, config: { CHAT_ID, EXTRACTION_MODEL: "claude-haiku-5-5", MONTHLY_LLM_BUDGET_USD: 5 } });
    expect(stats.calls).toBe(1);
    expect(stats.topics).toBe(1);
    expect(stats.signals).toBe(2);
    expect(stats.factsAdded).toBe(1);
    expect(stats.factsReinforced).toBe(1);
    const [topic] = await sql<{ importance: number; slug: string | null }[]>`
      SELECT c.importance, p.slug FROM chronicle c LEFT JOIN projects p ON p.id = c.project_id WHERE c.title = 'Релиз Atlas 0.2'`;
    expect(topic!.importance).toBe(5);
    expect(topic!.slug).toBe("atlas");
    expect(prompt).toContain("Поставил Atlas");

    const [pending] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM messages WHERE extracted_at IS NULL`;
    expect(pending!.count).toBe(0);

    const second = await runExtractionPass({ sql, anthropic: fakeAnthropic, config: { CHAT_ID, EXTRACTION_MODEL: "claude-haiku-5-5", MONTHLY_LLM_BUDGET_USD: 5 } });
    expect(second.calls).toBe(0);

    const projects = await listProjects(sql);
    const atlas = projects.find((project) => project.slug === "atlas")!;
    expect(atlas.signals_count).toBe(2);
    expect(atlas.score).toBeGreaterThan(0);
    expect(projects[0]!.slug).toBe("atlas");

    expect(await setVote(sql, atlas.id, author.id, true)).toBe("own_project");
    expect(await setVote(sql, atlas.id, fan.id, true)).toBe("ok");
    const afterVote = (await listProjects(sql)).find((project) => project.slug === "atlas")!;
    expect(afterVote.score).toBe(atlas.score + 5);
  });

  it("whoknows and catchup work without the LLM", async () => {
    const experts = await whoKnows(sql, "swift");
    expect(experts.some((person) => person.username === "anna_dev")).toBe(true);

    const fan = await resolveUser(sql, { id: 4004, username: "fan", first_name: "Фанат" }, []);
    const catchup = await catchupFor(sql, CHAT_ID, { ...fan, last_message_at: new Date(Date.now() - 3 * 3_600_000) }, 5);
    expect(catchup.entries.length).toBeGreaterThan(0);
    expect(catchup.unprocessed.count).toBe(0);
  });

  it("builds a prompt that lists participants with fact ids", async () => {
    const [user] = await sql<{ id: number }[]>`SELECT id FROM users WHERE username = 'anna_dev'`;
    const prompt = buildExtractionPrompt({
      batch: [{ chat_id: CHAT_ID, msg_id: 1, user_id: user!.id, sent_at: new Date(), text: "привет", reply_to_msg_id: null, is_forward: false, forward_source: null, media_type: null }],
      context: [],
      users: await sql`SELECT * FROM users`,
      facts: await sql`SELECT * FROM facts WHERE user_id = ${user!.id}`,
      projects: [],
    });
    expect(prompt).toMatch(/\[f\d+\] stack: Swift/);
    expect(prompt).toContain("<new_messages>");
    void applyExtraction;
  });

  it("serves the Mini App API only to members with valid initData", async () => {
    const app = createApi({ sql, botToken: TOKEN, chatId: CHAT_ID, adminTgIds: [], isMember: async (id) => id === 1001, webDistDir: "web/dist" });
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
    const user = await resolveUser(sql, { id: 7007, first_name: "Дубль" }, []);
    expect(await proposeFact(sql, { userId: user.id, kind: "stack", value: "Codex (тариф Max)", confidence: 0.9, sourceMsgIds: [1], source: "llm" })).toBe("added");
    expect(await proposeFact(sql, { userId: user.id, kind: "stack", value: "Codex (активно пользовался)", confidence: 0.9, sourceMsgIds: [2], source: "llm" })).toBe("reinforced");
    expect(await proposeFact(sql, { userId: user.id, kind: "stack", value: "Claude Code", confidence: 0.9, sourceMsgIds: [3], source: "llm" })).toBe("added");
    const { project } = await upsertProject(sql, { name: "Dupe Site", links: { site: "https://dupe.example.com/" }, authorIds: [user.id], sourceMsgIds: [], source: "user" });
    expect(await proposeFact(sql, { userId: user.id, kind: "link", value: "https://dupe.example.com", confidence: 0.9, sourceMsgIds: [4], source: "llm" })).toBe("skipped_existing");
    const again = await upsertProject(sql, { name: "Сайт Dupe Site", authorIds: [user.id], sourceMsgIds: [], source: "llm" });
    expect(again.project.id).toBe(project.id);
  });

  it("normalizes stacks: splits combined facts and folds one vendor's tools without losing anything", async () => {
    const user = await resolveUser(sql, { id: 9009, first_name: "Стек" }, []);
    for (const value of ["GPT-6", "Codex (тариф Max)", "Vercel, Scaleway", "Claude Code (вместе с Codex)"]) {
      await sql`INSERT INTO facts (user_id, kind, value, value_norm, confidence, status) VALUES (${user.id}, 'stack', ${value}, ${value.toLowerCase()}, 0.9, 'auto')`;
    }
    await normalizeStacks(sql);
    const stack = (await visibleFacts(sql, user.id)).filter((fact) => fact.kind === "stack").map((fact) => fact.value).sort();
    expect(stack).toEqual(["Claude", "GPT / Codex", "Scaleway", "Vercel"]);
    expect(await proposeFact(sql, { userId: user.id, kind: "stack", value: "ChatGPT", confidence: 0.9, sourceMsgIds: [1], source: "llm" })).toBe("reinforced");
  });

  it("consolidation merges facts and projects but never touches manual facts", async () => {
    const user = await resolveUser(sql, { id: 8008, first_name: "Уборка" }, []);
    await proposeFact(sql, { userId: user.id, kind: "role", value: "бэкенд", confidence: 0.9, sourceMsgIds: [1], source: "llm" });
    await proposeFact(sql, { userId: user.id, kind: "role", value: "тимлид", confidence: 0.9, sourceMsgIds: [2], source: "llm" });
    await proposeFact(sql, { userId: user.id, kind: "interest", value: "шахматы", confidence: 1, sourceMsgIds: [], source: "user" });
    await upsertProject(sql, { slug: "dup-a", name: "Dup A", authorIds: [user.id], sourceMsgIds: [], source: "llm" });
    await upsertProject(sql, { slug: "dup-b", name: "Другое имя B", authorIds: [user.id], sourceMsgIds: [], source: "llm" });
    const input = await loadConsolidationInput(sql);
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
    const facts = await visibleFacts(sql, user.id);
    expect(facts.filter((fact) => fact.kind === "role").map((fact) => fact.value)).toEqual(["бэкенд-тимлид"]);
    expect(facts.some((fact) => fact.value === "шахматы")).toBe(true);
    const [hidden] = await sql<{ hidden: boolean }[]>`SELECT hidden FROM projects WHERE slug = 'dup-b'`;
    expect(hidden!.hidden).toBe(true);
  });
});
