import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Sql } from "../core/db.js";
import { dropFact, mergeFacts, normalizeStacks, type Fact } from "../core/facts.js";
import { assertBudget, callStructured, recordUsage } from "../core/llm.js";
import { detectLanguage } from "../core/language.js";
import { mergeProjects, PROJECT_STATUSES, upsertProject, type ProjectStatus } from "../core/projects.js";
import { isProjectUpdate, PROMPT_STATUS_CODES } from "./extract.js";

/** Kinds whose values are written in words, so they show the chat's language (stack and links read the same anywhere). */
const WORDY_KINDS = new Set(["role", "expertise", "interest", "looking_for", "can_help"]);

export const ConsolidationSchema = z.object({
  fact_merges: z.array(z.object({ fact_ids: z.array(z.number().int()), value: z.string() })),
  fact_drops: z.array(z.object({ fact_id: z.number().int() })),
  project_merges: z.array(z.object({ into: z.string(), from: z.array(z.string()) })),
  project_updates: z.array(z.object({ slug: z.string(), tagline: z.string().nullable(), status: z.enum(PROJECT_STATUSES).nullable() })),
});

export type ConsolidationResult = z.infer<typeof ConsolidationSchema>;

export const CONSOLIDATION_SYSTEM_PROMPT = `You are the editor of the member cards and the project catalog of a private Telegram group chat. The cards are filled in automatically, and repeats pile up in them. Your job is to tidy them up without making anything up.

You receive the cards (member, facts with id and kind) and the project catalog (slug, name, status, authors, tagline, links).

Language
Write ALL content — merged fact values and project taglines — in the chat's language. When the input begins with <chat_language>, that is the chat's language: write in it. Otherwise it is the language most of the existing role, expertise and interest facts and project taglines are written in (names, stack facts and links do not count: they read the same in any language). When the facts you merge are in different languages, write the merged value in the chat's language. Never translate content into any language other than the chat's, English included. Never translate or transliterate names of people, products and technologies, but inflect them as the chat's language requires; stack facts use the fixed family names given below. These instructions are in English, and every example in them is only an illustration: no example is a reason to write in English when the cards are in another language.

A card is a short profile without repeats. Semantic duplicates are not allowed: merge two facts about the same thing (one product family, one topic in different words, the general and the specific — "Nintendo games" and "Nintendo Switch") into one.
- role — exactly one role per person. Fold several roles into one concise wording.
- stack — one technology per fact, by a short name with no explanations. AI models and tools from one company are ONE fact: OpenAI (GPT, ChatGPT, Codex, Astra) is "GPT / Codex", Anthropic (Claude, Opus, Claude Code) is "Claude", Google is "Gemini". Hardware and subscription plans do not belong in stack.
- expertise, interest — briefly, in one or two words or a short phrase.
- link — personal links only (a GitHub profile, a personal site, a portfolio), not links to projects from the catalog.
- project — projects are not kept on cards: they are in the catalog. Drop such facts.

What to do:
- fact_merges — groups of facts of ONE person and one kind that say the same thing or boil down to one ("Codex (Max plan)" + "Codex (used it actively)" → "Codex"; two entries about the same MacBook; several roles). fact_ids — all ids of the group, value — the final wording. You can pass a single id just to shorten its wording according to the rules above.
- fact_drops — facts that repeat the catalog (kind project, links to projects), carry no meaning or break the rules (hardware in stack, finances, personal matters).
- Facts marked ✍️ were written by the person themselves: do not merge, reword or drop them.
- project_merges — catalog entries about the same product (into — the slug that stays, usually the one with the better name; from — the slugs of the duplicates).
- project_updates — a tagline (one sentence, nothing about money or personal matters) or a status, if the current ones are clearly inaccurate or the tagline describes a different product. Otherwise leave them alone. status — one of ${PROMPT_STATUS_CODES}; statuses are fixed codes, not content: copy the quoted code exactly and never translate it.

If there is nothing to clean up, return empty arrays.`;

export interface ConsolidationInput {
  chatId: number;
  users: { id: number; display_name: string }[];
  facts: Fact[];
  projects: { slug: string; name: string; tagline: string | null; status: ProjectStatus; links: Record<string, unknown>; authors: string[] }[];
}

/** Hidden facts stay out of the clean-up: the person hid them, so neither a merge nor a drop may touch them. */
export async function loadConsolidationInput(sql: Sql, chatId: number): Promise<ConsolidationInput> {
  const users = await sql<{ id: number; display_name: string }[]>`
    SELECT u.id, u.display_name FROM users u JOIN members m ON m.user_id = u.id
    WHERE m.chat_id = ${chatId} AND NOT m.opted_out ORDER BY u.id`;
  const facts = await sql<Fact[]>`SELECT * FROM facts WHERE chat_id = ${chatId} AND status IN ('auto', 'manual') ORDER BY user_id, kind, id`;
  const projects = await sql<ConsolidationInput["projects"]>`
    SELECT p.slug, p.name, p.tagline, p.status, p.links,
           coalesce(array_agg('u' || pm.user_id) FILTER (WHERE pm.user_id IS NOT NULL), '{}') AS authors
    FROM projects p LEFT JOIN project_members pm ON pm.project_id = p.id
    WHERE p.chat_id = ${chatId} AND NOT p.hidden GROUP BY p.id ORDER BY p.slug`;
  return { chatId, users, facts, projects };
}

export function buildConsolidationPrompt(input: ConsolidationInput): string {
  const cards = input.users
    .map((user) => {
      const facts = input.facts.filter((fact) => fact.user_id === user.id);
      if (facts.length === 0) return "";
      return `u${user.id} | ${user.display_name}\n${facts.map((fact) => `  [f${fact.id}] ${fact.kind}: ${fact.value}${fact.status === "manual" ? " ✍️" : ""}`).join("\n")}`;
    })
    .filter(Boolean)
    .join("\n");
  const catalog = input.projects
    .map((project) => `${project.slug} | ${project.name} | ${project.status} | authors: ${project.authors.join(", ")} | ${project.tagline ?? ""} | ${JSON.stringify(project.links)}`)
    .join("\n");
  const language = detectLanguage([
    ...input.facts.filter((fact) => WORDY_KINDS.has(fact.kind)).map((fact) => fact.value),
    ...input.projects.map((project) => project.tagline ?? ""),
  ]);
  return `${language ? `<chat_language>${language}</chat_language>\n\n` : ""}<cards>\n${cards}\n</cards>\n\n<catalog>\n${catalog}\n</catalog>`;
}

export interface ConsolidationStats {
  factsMerged: number;
  factsDropped: number;
  projectsMerged: number;
  projectsUpdated: number;
}

export async function applyConsolidation(sql: Sql, input: ConsolidationInput, result: ConsolidationResult): Promise<ConsolidationStats> {
  const stats: ConsolidationStats = { factsMerged: 0, factsDropped: 0, projectsMerged: 0, projectsUpdated: 0 };
  const facts = new Map(input.facts.map((fact) => [fact.id, fact]));
  const touched = new Set<number>();

  for (const merge of result.fact_merges) {
    const ids = [...new Set(merge.fact_ids)].filter((id) => facts.has(id) && !touched.has(id));
    if (ids.length === 0) continue;
    const owners = new Set(ids.map((id) => facts.get(id)!.user_id));
    const kinds = new Set(ids.map((id) => facts.get(id)!.kind));
    if (owners.size !== 1 || kinds.size !== 1) continue;
    if (await mergeFacts(sql, ids, merge.value, "llm")) {
      stats.factsMerged += ids.length;
      ids.forEach((id) => touched.add(id));
    }
  }
  for (const drop of result.fact_drops) {
    if (!facts.has(drop.fact_id) || touched.has(drop.fact_id)) continue;
    if (await dropFact(sql, drop.fact_id, "llm")) stats.factsDropped += 1;
  }

  const slugs = new Set(input.projects.map((project) => project.slug));
  for (const merge of result.project_merges) {
    if (!slugs.has(merge.into)) continue;
    stats.projectsMerged += await mergeProjects(sql, input.chatId, merge.into, merge.from.filter((slug) => slugs.has(slug)));
  }
  for (const update of result.project_updates) {
    const project = input.projects.find((candidate) => candidate.slug === update.slug);
    if (!project || (!update.tagline && !update.status)) continue;
    const outcome = await upsertProject(sql, { chatId: input.chatId, slug: project.slug, name: project.name, tagline: update.tagline, status: update.status, authorIds: [], sourceMsgIds: [], source: "llm" });
    if (isProjectUpdate(outcome)) stats.projectsUpdated += 1;
  }
  await sql`
    INSERT INTO app_state (key, value) VALUES (${stateKey(input.chatId)}, ${sql.json({ at: new Date().toISOString(), stats: { ...stats } })})
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`;
  return stats;
}

const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;
/** A large chat's first clean-up can produce a long answer; the stream makes the room cheap to offer. */
const CONSOLIDATION_MAX_TOKENS = 64000;

/** Weekly, and only when cards or the catalog changed since the previous clean-up. */
const stateKey = (chatId: number) => `last_consolidation:${chatId}`;
/** Written before every paid call, so a clean-up that keeps failing is retried with a growing pause instead of on every tick. */
const attemptKey = (chatId: number) => `consolidation_attempt:${chatId}`;

/** 1 h after the first failed attempt, then 4 h, 16 h, about 3 days, and at most a week. */
export function consolidationRetryDelayMs(failedAttempts: number): number {
  return Math.min(WEEK_MS, HOUR_MS * 4 ** Math.max(0, failedAttempts - 1));
}

/** Attempts made since the last successful clean-up; the newest one is unfinished, i.e. it failed. */
async function failedAttempts(sql: Sql, chatId: number): Promise<{ count: number; lastAt: Date } | null> {
  const rows = await sql<{ key: string; value: { attempts?: number }; updated_at: Date }[]>`
    SELECT key, value, updated_at FROM app_state WHERE key IN (${stateKey(chatId)}, ${attemptKey(chatId)})`;
  const attempt = rows.find((row) => row.key === attemptKey(chatId));
  const done = rows.find((row) => row.key === stateKey(chatId));
  if (!attempt || (done && done.updated_at >= attempt.updated_at)) return null;
  return { count: Number(attempt.value.attempts ?? 1), lastAt: attempt.updated_at };
}

/** When a clean-up that failed may run again; null when the last one did not fail. */
export async function nextConsolidationRetryAt(sql: Sql, chatId: number): Promise<Date | null> {
  const failed = await failedAttempts(sql, chatId);
  return failed ? new Date(failed.lastAt.getTime() + consolidationRetryDelayMs(failed.count)) : null;
}

export async function isConsolidationDue(sql: Sql, chatId: number, now = new Date()): Promise<boolean> {
  const retryAt = await nextConsolidationRetryAt(sql, chatId);
  if (retryAt && now < retryAt) return false;
  const [state] = await sql<{ updated_at: Date }[]>`SELECT updated_at FROM app_state WHERE key = ${stateKey(chatId)}`;
  if (state && now.getTime() - state.updated_at.getTime() < WEEK_MS) return false;
  const since = state?.updated_at ?? new Date(0);
  const [changed] = await sql<{ changed: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM facts WHERE chat_id = ${chatId} AND updated_at > ${since})
        OR EXISTS (SELECT 1 FROM projects WHERE chat_id = ${chatId} AND updated_at > ${since}) AS changed`;
  return Boolean(changed?.changed);
}

export async function runConsolidation(
  sql: Sql,
  anthropic: Anthropic,
  model: string,
  budget: { totalUsd: number; chatId: number; chatUsd: number },
  /** Cancels the call, when the bot is stopping and cannot wait for it. */
  signal?: AbortSignal,
  /** The chat as Anthropic's end user (chatEndUserId). */
  endUserId?: string,
): Promise<ConsolidationStats> {
  const chatId = budget.chatId;
  await assertBudget(sql, budget.totalUsd, { id: chatId, limitUsd: budget.chatUsd });
  const previous = await failedAttempts(sql, chatId);
  await sql`
    INSERT INTO app_state (key, value) VALUES (${attemptKey(chatId)}, ${sql.json({ attempts: (previous?.count ?? 0) + 1 })})
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`;
  await normalizeStacks(sql, chatId);
  const input = await loadConsolidationInput(sql, chatId);
  const outcome = await callStructured(anthropic, {
    model,
    maxTokens: CONSOLIDATION_MAX_TOKENS,
    system: CONSOLIDATION_SYSTEM_PROMPT,
    prompt: buildConsolidationPrompt(input),
    schema: ConsolidationSchema,
    onUsage: (usage) => recordUsage(sql, "consolidate", model, usage, chatId),
    signal,
    endUserId,
  });
  if (!outcome.ok) throw new Error(`Card clean-up stopped: ${outcome.message}`);
  return applyConsolidation(sql, input, outcome.data);
}
