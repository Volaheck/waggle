import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { LEGACY_CHAT_ID } from "../core/chats.js";
import { createSql, migrate, type Sql } from "../core/db.js";
import { FACT_KINDS, proposeFact } from "../core/facts.js";
import { PROJECT_STATUSES, setMemberRole, upsertProject } from "../core/projects.js";

const PersonSchema = z.object({
  display_name: z.string().min(1),
  username: z.string().nullable().optional(),
  tagline: z.string().nullable().optional(),
  facts: z.array(
    z.object({
      kind: z.enum(FACT_KINDS),
      value: z.string().min(1),
      confidence: z.number().min(0).max(1),
      source_msg_ids: z.array(z.number().int()),
    }),
  ),
});

const ProjectSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  tagline: z.string().nullable().optional(),
  status: z.enum(PROJECT_STATUSES),
  stack: z.array(z.string()).default([]),
  links: z.object({ repo: z.string().nullable().optional(), site: z.string().nullable().optional(), other: z.array(z.string()).optional() }),
  authors: z.array(z.string()),
  author_roles: z.record(z.string(), z.string()).optional(),
  source_msg_ids: z.array(z.number().int()).default([]),
  first_seen_msg_id: z.number().int().nullable().optional(),
  confidence: z.number().min(0).max(1).default(1),
});

export type SeedPerson = z.infer<typeof PersonSchema>;
export type SeedProject = z.infer<typeof ProjectSchema>;

/** A seeded person is matched by @username anywhere, or by name among the chat's members. */
async function upsertSeedUser(sql: Sql, chatId: number, person: SeedPerson): Promise<number> {
  const username = person.username?.replace(/^@/, "") || null;
  const [existing] = await sql<{ id: number }[]>`
    SELECT u.id FROM users u
    WHERE (${username}::text IS NOT NULL AND lower(u.username) = lower(${username}::text))
       OR (lower(u.display_name) = lower(${person.display_name})
           AND EXISTS (SELECT 1 FROM members m WHERE m.user_id = u.id AND m.chat_id = ${chatId}))
    ORDER BY u.tg_id IS NOT NULL DESC
    LIMIT 1`;
  let userId = existing?.id;
  if (userId !== undefined) {
    await sql`UPDATE users SET username = coalesce(username, ${username}) WHERE id = ${userId}`;
  } else {
    const [created] = await sql<{ id: number }[]>`
      INSERT INTO users (username, display_name) VALUES (${username}, ${person.display_name})
      RETURNING id`;
    userId = created!.id;
  }
  await sql`
    INSERT INTO members (chat_id, user_id, tagline) VALUES (${chatId}, ${userId}, ${person.tagline ?? null})
    ON CONFLICT (chat_id, user_id) DO UPDATE SET tagline = coalesce(members.tagline, excluded.tagline)`;
  return userId;
}

export async function importSeed(sql: Sql, chatId: number, people: SeedPerson[], projects: SeedProject[]): Promise<{ users: number; facts: number; projects: number }> {
  const ids = new Map<string, number>();
  let facts = 0;
  for (const person of people) {
    const userId = await upsertSeedUser(sql, chatId, person);
    ids.set(person.display_name.toLowerCase(), userId);
    for (const fact of person.facts) {
      const result = await proposeFact(sql, { chatId, userId, kind: fact.kind, value: fact.value, confidence: fact.confidence, sourceMsgIds: fact.source_msg_ids, source: "seed" });
      if (result === "added") facts += 1;
    }
  }
  for (const project of projects) {
    const authorIds = project.authors.map((name) => ids.get(name.toLowerCase())).filter((id): id is number => id !== undefined);
    // The seed only fills gaps: whatever the chronicler or people changed since then stays.
    const [present] = await sql<{ id: number }[]>`SELECT id FROM projects WHERE chat_id = ${chatId} AND slug = ${project.slug}`;
    if (present) {
      for (const authorId of authorIds) {
        await sql`INSERT INTO project_members (project_id, user_id) VALUES (${present.id}, ${authorId}) ON CONFLICT DO NOTHING`;
      }
      for (const [name, role] of Object.entries(project.author_roles ?? {})) {
        const userId = ids.get(name.toLowerCase());
        if (userId !== undefined) await setMemberRole(sql, present.id, userId, role);
      }
      continue;
    }
    const { project: stored } = await upsertProject(sql, {
      chatId,
      slug: project.slug,
      name: project.name,
      tagline: project.tagline ?? null,
      status: project.status,
      stack: project.stack,
      links: { repo: project.links.repo ?? null, site: project.links.site ?? null, other: project.links.other ?? [] },
      authorIds,
      sourceMsgIds: project.source_msg_ids,
      firstSeenMsgId: project.first_seen_msg_id ?? null,
      confidence: project.confidence,
      source: "seed",
    });
    for (const [name, role] of Object.entries(project.author_roles ?? {})) {
      const userId = ids.get(name.toLowerCase());
      if (userId !== undefined) await setMemberRole(sql, stored.id, userId, role);
    }
  }
  return { users: ids.size, facts, projects: projects.length };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).includes(`scripts${path.sep}seed`);
if (isMain) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const [peopleFile = "seed/people.json", projectsFile = "seed/projects.json"] = process.argv.slice(2);
  const people = z.array(PersonSchema).parse(JSON.parse(await readFile(peopleFile, "utf8")));
  const projects = z.array(ProjectSchema).parse(JSON.parse(await readFile(projectsFile, "utf8")));
  // Without SEED_CHAT_ID the cards wait as imported history until a bot owner attaches them to a chat.
  const chatId = Number(process.env.SEED_CHAT_ID ?? LEGACY_CHAT_ID);
  if (!Number.isInteger(chatId)) throw new Error("SEED_CHAT_ID must be a Telegram chat id");
  const sql = createSql(databaseUrl);
  await migrate(sql);
  const result = await importSeed(sql, chatId, people, projects);
  console.log(`Done: ${result.users} members, ${result.facts} new facts, ${result.projects} projects`);
  await sql.end();
}
