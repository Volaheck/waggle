import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Sql } from "../core/db.js";
import { dropFact, mergeFacts, normalizeStacks, type Fact } from "../core/facts.js";
import { assertBudget, recordUsage } from "../core/llm.js";
import { mergeProjects, PROJECT_STATUSES, upsertProject } from "../core/projects.js";

export const ConsolidationSchema = z.object({
  fact_merges: z.array(z.object({ fact_ids: z.array(z.number().int()), value: z.string() })),
  fact_drops: z.array(z.object({ fact_id: z.number().int() })),
  project_merges: z.array(z.object({ into: z.string(), from: z.array(z.string()) })),
  project_updates: z.array(z.object({ slug: z.string(), tagline: z.string().nullable(), status: z.enum(PROJECT_STATUSES).nullable() })),
});

export type ConsolidationResult = z.infer<typeof ConsolidationSchema>;

export const CONSOLIDATION_SYSTEM_PROMPT = `Ты — редактор карточек участников и каталога проектов закрытого Telegram-чата. Карточки пополняются автоматически, и в них копятся повторы. Твоя задача — навести порядок, ничего не выдумывая.

Ты получаешь карточки (участник, факты с id и видом) и каталог проектов (slug, название, описание, статус, авторы, ссылки).

Карточка — короткая анкета без повторов. Смысловые дубли недопустимы: два факта об одном и том же (одно семейство продуктов, одна тема разными словами, общее и частное — «игры Nintendo» и «Nintendo Switch») сливай в один.
- role — ровно одна роль на человека. Несколько ролей сведи в одну ёмкую формулировку.
- stack — одна технология на факт, коротким названием без пояснений. ИИ-модели и инструменты одной компании — ОДИН факт: OpenAI (GPT, ChatGPT, Codex, Astra) — «GPT / Codex», Anthropic (Claude, Opus, Claude Code) — «Claude», Google — «Gemini». Железо и тарифы — не стек.
- expertise, interest — коротко, одним-двумя словами или короткой фразой.
- link — только личные ссылки (GitHub-профиль, личный сайт, портфолио), не ссылки на проекты из каталога.
- project — проекты в карточке не хранятся: они есть в каталоге. Удаляй такие факты.

Что делать:
- fact_merges — группы фактов ОДНОГО человека и одного вида, которые говорят одно и то же или сводятся к одному («Codex (тариф Max)» + «Codex (активно пользовался)» → «Codex»; две записи про один MacBook; несколько ролей). fact_ids — все id группы, value — итоговая формулировка. Можно передать одну id, чтобы просто укоротить формулировку по правилам выше.
- fact_drops — факты, которые повторяют каталог (вид project, ссылки на проекты), не несут смысла или нарушают правила (железо в стеке, финансы, личное).
- Факты, помеченные ✍️, написал сам человек: их не объединяй, не переформулируй и не удаляй.
- project_merges — записи каталога об одном и том же продукте (into — slug, который остаётся, обычно с лучшим названием; from — slug'и дублей).
- project_updates — описание (одна фраза, без денег и личного) или статус, если текущие явно неточны или описание говорит о другом продукте. Иначе не трогай.

Если чистить нечего — верни пустые массивы.`;

export interface ConsolidationInput {
  users: { id: number; display_name: string }[];
  facts: Fact[];
  projects: { slug: string; name: string; tagline: string | null; status: string; links: Record<string, unknown>; authors: string[] }[];
}

export async function loadConsolidationInput(sql: Sql): Promise<ConsolidationInput> {
  const users = await sql<{ id: number; display_name: string }[]>`SELECT id, display_name FROM users WHERE NOT opted_out ORDER BY id`;
  const facts = await sql<Fact[]>`SELECT * FROM facts WHERE status IN ('auto', 'manual', 'hidden') ORDER BY user_id, kind, id`;
  const projects = await sql<ConsolidationInput["projects"]>`
    SELECT p.slug, p.name, p.tagline, p.status, p.links,
           coalesce(array_agg('u' || pm.user_id) FILTER (WHERE pm.user_id IS NOT NULL), '{}') AS authors
    FROM projects p LEFT JOIN project_members pm ON pm.project_id = p.id
    WHERE NOT p.hidden GROUP BY p.id ORDER BY p.slug`;
  return { users, facts, projects };
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
    .map((project) => `${project.slug} | ${project.name} | ${project.status} | авторы: ${project.authors.join(", ")} | ${project.tagline ?? ""} | ${JSON.stringify(project.links)}`)
    .join("\n");
  return `<cards>\n${cards}\n</cards>\n\n<catalog>\n${catalog}\n</catalog>`;
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
    stats.projectsMerged += await mergeProjects(sql, merge.into, merge.from.filter((slug) => slugs.has(slug)));
  }
  for (const update of result.project_updates) {
    const project = input.projects.find((candidate) => candidate.slug === update.slug);
    if (!project || (!update.tagline && !update.status)) continue;
    await upsertProject(sql, { slug: project.slug, name: project.name, tagline: update.tagline, status: update.status, authorIds: [], sourceMsgIds: [], source: "llm" });
    stats.projectsUpdated += 1;
  }
  await sql`
    INSERT INTO app_state (key, value) VALUES ('last_consolidation', ${sql.json({ at: new Date().toISOString(), stats: { ...stats } })})
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`;
  return stats;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Weekly, and only when cards or the catalog changed since the previous clean-up. */
export async function isConsolidationDue(sql: Sql, now = new Date()): Promise<boolean> {
  const [state] = await sql<{ updated_at: Date }[]>`SELECT updated_at FROM app_state WHERE key = 'last_consolidation'`;
  if (state && now.getTime() - state.updated_at.getTime() < WEEK_MS) return false;
  const since = state?.updated_at ?? new Date(0);
  const [changed] = await sql<{ changed: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM facts WHERE updated_at > ${since}) OR EXISTS (SELECT 1 FROM projects WHERE updated_at > ${since}) AS changed`;
  return Boolean(changed?.changed);
}

export async function runConsolidation(sql: Sql, anthropic: Anthropic, model: string, budgetUsd: number): Promise<ConsolidationStats> {
  await assertBudget(sql, budgetUsd);
  await normalizeStacks(sql);
  const input = await loadConsolidationInput(sql);
  const response = await anthropic.messages
    .stream({
      model,
      max_tokens: 16000,
      output_config: { effort: "low", format: zodOutputFormat(ConsolidationSchema) },
      system: CONSOLIDATION_SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildConsolidationPrompt(input) }],
    })
    .finalMessage();
  await recordUsage(sql, "consolidate", model, response.usage);
  if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") throw new Error(`Card clean-up stopped: ${response.stop_reason}`);
  const text = response.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  const parsed = ConsolidationSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`Card clean-up: response does not match the schema: ${parsed.error.message}`);
  return applyConsolidation(sql, input, parsed.data);
}
