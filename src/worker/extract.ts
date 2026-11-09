import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Config } from "../core/config.js";
import type { Sql } from "../core/db.js";
import { deprecateFact, proposeFact, rewriteFact, type Fact } from "../core/facts.js";
import { assertBudget, recordUsage } from "../core/llm.js";
import type { StoredMessage } from "../core/messages.js";
import { PROJECT_STATUSES, upsertProject } from "../core/projects.js";
import { hasForbiddenTopic, slugify, truncate } from "../core/text.js";
import type { User } from "../core/users.js";

/** Projects are not facts: they live only in the catalog, so cards never repeat them. */
export const EXTRACTABLE_KINDS = ["role", "stack", "expertise", "interest", "link", "timezone"] as const;
export const TOPIC_KINDS = ["discussion", "project", "link", "news"] as const;
export const SIGNAL_KINDS = ["praise", "critique", "usage", "contribution", "interest", "milestone"] as const;

const MIN_STORED_CONFIDENCE = 0.5;
const MIN_PROJECT_CONFIDENCE = 0.6;
const CONTEXT_MESSAGES = 20;
/** Safety valve for an abnormal burst; a normal interval fits into one call. */
const MAX_MESSAGES_PER_CALL = 2500;
const MAX_CALLS_PER_PASS = 10;

export const ExtractionSchema = z.object({
  topics: z.array(
    z.object({
      title: z.string(),
      summary: z.string(),
      kind: z.enum(TOPIC_KINDS),
      importance: z.number().int(),
      project: z.string().nullable(),
      msg_ids: z.array(z.number().int()),
    }),
  ),
  facts_add: z.array(
    z.object({
      person: z.string(),
      kind: z.enum(EXTRACTABLE_KINDS),
      value: z.string(),
      confidence: z.number(),
      source_msg_ids: z.array(z.number().int()),
    }),
  ),
  facts_update: z.array(
    z.object({
      fact_id: z.number().int(),
      value: z.string(),
      source_msg_ids: z.array(z.number().int()),
    }),
  ),
  facts_outdated: z.array(
    z.object({
      fact_id: z.number().int(),
      source_msg_ids: z.array(z.number().int()),
    }),
  ),
  projects: z.array(
    z.object({
      slug: z.string(),
      name: z.string(),
      tagline: z.string().nullable(),
      status: z.enum(PROJECT_STATUSES).nullable(),
      stack: z.array(z.string()),
      repo: z.string().nullable(),
      site: z.string().nullable(),
      authors: z.array(z.string()),
      confidence: z.number(),
      source_msg_ids: z.array(z.number().int()),
    }),
  ),
  project_signals: z.array(
    z.object({
      project: z.string().describe("slug проекта из каталога или из projects в этом же ответе"),
      person: z.string().describe("ref участника, от которого исходит сигнал"),
      kind: z.enum(SIGNAL_KINDS),
      impact: z.number().int(),
      note: z.string(),
      source_msg_ids: z.array(z.number().int()),
    }),
  ),
  taglines: z.array(
    z.object({
      person: z.string(),
      tagline: z.string(),
    }),
  ),
});

export type ExtractionResult = z.infer<typeof ExtractionSchema>;

export const EXTRACTION_SYSTEM_PROMPT = `Ты — летописец закрытого Telegram-чата друзей. Раз в несколько часов ты получаешь все новые сообщения за этот промежуток: пишешь летопись (о чём говорили), обновляешь карточки участников, каталог их проектов и отмечаешь, что происходит с проектами. Всё это видят участники, поэтому точность важнее полноты.

Ты получаешь: участников (ref вида u12, имя, @username, текущие факты с id), каталог проектов, несколько предыдущих сообщений для контекста и НОВЫЕ сообщения. Работай только с НОВЫМИ сообщениями; контекст нужен, чтобы понять, о чём речь.

1. Летопись (topics)
Летопись — это не стенограмма, а главное, что произошло. Выдели только содержательные ветки — обычно 1–6 на пачку.
- Если ветка продолжает тему из <recent_chronicle>, не заводи новую тему, если не случилось чего-то нового и важного.
- title — 3–8 слов, по сути («Аня выкатила новую версию Atlas», «Спор Claude vs Codex для фронтенда»).
- summary — 1–2 предложения: кто участвовал, к чему пришли, что полезного прозвучало. Называй людей по именам.
- kind — discussion (обсуждение), project (новости проектов участников: релизы, демо, идеи), link (полезная ссылка или инструмент), news (пересланная новость, вокруг которой было обсуждение).
- importance 1–5 — насколько событие важно для чата: 5 — событие недели (релиз или запуск проекта участника, крупное решение, новость, которую обсуждали все); 4 — заметное (демо, большая полезная дискуссия, важный совет); 3 — обычное содержательное обсуждение; 2 — мелочь, интересная немногим; 1 — почти флуд. Будь строг: пятёрок мало.
- project — slug проекта из каталога, если тема именно про проект участника; иначе null. Решай по смыслу, а не по совпадению слов: одноимённый чужой продукт (очки «Nova Glass» от чужой компании — не проект участника «nova») или общий разговор, где название мелькнуло, — это null.
- msg_ids — 1–5 id самых показательных новых сообщений темы, первым — то, с которого тема началась.
Пропускай флуд, приветствия, стикеры и пересланные новости без обсуждения. Не пересказывай личное, здоровье, финансы, политические споры, пароли и секреты — такие ветки просто опускай.

2. Факты об участниках
Карточка — короткая анкета, а не дневник. Каждый факт — одна мысль. Смысловые дубли недопустимы: если новый факт по сути про то же, что уже есть (тот же продукт, то же семейство, та же тема другими словами), — не добавляй его.
- role — чем человек занимается. У человека ОДНА роль: если уже есть role, уточняй её через facts_update, а не добавляй вторую.
- stack — одна технология на факт, коротким общепринятым названием, без пояснений: «Rust», «Railway», «Blender». ИИ-модели и инструменты одной компании — ОДИН факт: всё от OpenAI (GPT-любой версии, ChatGPT, Codex, Astra, Sol) — «GPT / Codex»; всё от Anthropic (Claude, Opus, Sonnet, Claude Code) — «Claude»; Google — «Gemini». Железо и тарифы — не стек.
- expertise — тема реального опыта, о которой его полезно спросить, коротко: «self-hosted VPN», «Unity-шейдеры».
- interest — устойчивое увлечение одним-двумя словами: «Minecraft», «скайдайвинг», «e-ink ридеры».
- link — публичная ссылка на личное: GitHub-профиль, личный сайт, портфолио. Ссылки на проекты сюда не пиши — они в каталоге.
- timezone — страна или город, только если он сам прямо сказал, где живёт.
Проекты людей НЕ записывай фактами — только в projects (каталог).
Правила:
- facts_add — только то, чего в карточке ещё нет ни в каком виде. Если новое уточняет существующий факт — facts_update с его id и новой формулировкой.
- Факт должен следовать из слов самого человека или прямого подтверждения другими. Пересланные посты («переслано из …») ничего не говорят об авторе пересылки.
- В чате много иронии, мемов и шуток. Сарказм, гиперболы и разовые реплики — не факты.
- Никогда не записывай: политические взгляды, отношение к войне и странам, здоровье, финансы и доходы, личную жизнь и семью, точный адрес, конфликты между участниками, пароли и любые секреты.
- confidence от 0.5 до 1.0: 0.9+ — человек прямо сказал о себе; 0.7 — уверенно следует из нескольких реплик; 0.5–0.6 — вероятно, но нужно подтверждение.
- source_msg_ids — 1–3 id новых сообщений, на которых основан факт.
- facts_outdated — id существующих фактов, которые новые сообщения явно опровергают («перешёл с Codex на Claude» делает «Codex» устаревшим). Если сомневаешься — не трогай.

3. Проекты (projects)
- Только проекты участников, которые они сами делают или делали: «я сделал», «мой», «пилю», «закинул релиз», демо своего продукта, свой репозиторий. Чужие репозитории, новости, awesome-списки и пересланное — не проекты.
- Если проект уже есть в каталоге (даже под другим названием или упомянут по ссылке), используй его slug и присылай только новое или изменившееся (статус, стек, ссылки, описание). Не заводи второй проект для того же продукта.
- slug — латиница в kebab-case. authors — ref'ы участников. status — «идея», «в работе», «запущен», «на паузе» или «заброшен», либо null, если не ясно.

4. Сигналы по проектам (project_signals) — из них складывается рейтинг проектов, поэтому оценивай честно и строго.
- praise — участник искренне хвалит чужой проект, делится впечатлением после того, как попробовал.
- critique — содержательная критика или баг-репорт: человек вник в проект, это тоже признак ценности.
- usage — участник реально пользуется проектом («поставил», «юзаю каждый день», «перешёл на него»).
- contribution — помог проекту: код, дизайн, тестирование, идеи, которые автор принял.
- interest — предметный интерес: вопросы по делу, желание попробовать, просьба дать доступ.
- milestone — автор сообщил о реальном развитии: релиз, запуск, заметное обновление, первые пользователи.
Правила:
- person — тот, от кого исходит сигнал. Автор проекта может давать только milestone; хвалить, «пользоваться» и интересоваться своим проектом он не может.
- Простое упоминание названия, мемы, шутки, вежливое «прикольно» без содержания, повтор одного и того же — не сигнал. Одноимённый чужой продукт — тоже не сигнал этому проекту.
- Один человек — не больше одного сигнала каждого вида на проект за пачку.
- impact 1–5 — насколько это весомо: 1 — мелочь, 3 — заметно, 5 — исключительно (подробный отзыв после реального использования, крупный релиз).
- note — одна фраза по-русски, что произошло («Миша перешёл на Atlas для трекинга привычек»). Без секретов и личного.
- project — slug из каталога; если проект новый и ты добавил его в projects — тот же slug.

5. taglines — однострочник «кто это» (до 90 символов, без оценок) только для участников без однострочника, о ком теперь достаточно информации.

Пустые массивы — нормальный результат, если нового нет.`;

interface BatchData {
  batch: StoredMessage[];
  context: StoredMessage[];
  users: User[];
  facts: Fact[];
  projects: { slug: string; name: string; status: string; authors: string[] }[];
  recentTopics?: { title: string; period_to: Date }[];
}

export interface PendingStats {
  count: number;
  oldest: Date | null;
}

export async function pendingStats(sql: Sql, chatId: number): Promise<PendingStats> {
  const [row] = await sql<PendingStats[]>`
    SELECT count(*)::int AS count, min(sent_at) AS oldest
    FROM messages
    WHERE chat_id = ${chatId} AND extracted_at IS NULL AND NOT is_forward AND length(text) >= 3`;
  return row ?? { count: 0, oldest: null };
}

export async function lastSuccessfulRunAt(sql: Sql): Promise<Date | null> {
  const [row] = await sql<{ at: Date | null }[]>`SELECT max(finished_at) AS at FROM extraction_runs WHERE status = 'done'`;
  return row?.at ?? null;
}

/** Every `intervalHours` the extractor takes whatever piled up since the previous pass — no message-count thresholds. */
export function isPassDue(pending: PendingStats, lastRunAt: Date | null, intervalHours: number, now = new Date()): boolean {
  if (pending.count === 0 || !pending.oldest) return false;
  const reference = lastRunAt ?? pending.oldest;
  return now.getTime() - reference.getTime() >= intervalHours * 3_600_000;
}

async function loadBatch(sql: Sql, chatId: number, limit: number): Promise<BatchData | null> {
  const batch = await sql<StoredMessage[]>`
    SELECT chat_id, msg_id, user_id, sent_at, text, reply_to_msg_id, is_forward, forward_source, media_type
    FROM messages
    WHERE chat_id = ${chatId} AND extracted_at IS NULL
    ORDER BY msg_id
    LIMIT ${limit}`;
  if (batch.length === 0) return null;
  const context = (
    await sql<StoredMessage[]>`
      SELECT chat_id, msg_id, user_id, sent_at, text, reply_to_msg_id, is_forward, forward_source, media_type
      FROM messages
      WHERE chat_id = ${chatId} AND msg_id < ${batch[0]!.msg_id}
      ORDER BY msg_id DESC
      LIMIT ${CONTEXT_MESSAGES}`
  ).reverse();

  const authorIds = [...new Set(batch.map((message) => message.user_id).filter((id): id is number => id !== null))];
  const users = await sql<User[]>`SELECT * FROM users WHERE left_at IS NULL OR id = ANY(${authorIds})`;
  const involved = involvedUserIds(batch, [...context, ...batch], users);
  const facts = involved.length
    ? await sql<Fact[]>`SELECT * FROM facts WHERE user_id = ANY(${involved}) AND status IN ('auto', 'manual') ORDER BY user_id, kind, id`
    : [];
  const projects = await sql<{ slug: string; name: string; status: string; authors: string[] }[]>`
    SELECT p.slug, p.name, p.status,
           coalesce(array_agg('u' || pm.user_id) FILTER (WHERE pm.user_id IS NOT NULL), '{}') AS authors
    FROM projects p LEFT JOIN project_members pm ON pm.project_id = p.id
    WHERE NOT p.hidden
    GROUP BY p.id
    ORDER BY p.name`;
  const recentTopics = await sql<{ title: string; period_to: Date }[]>`
    SELECT title, period_to FROM chronicle
    WHERE period_to > ${batch[0]!.sent_at}::timestamptz - interval '3 days'
    ORDER BY period_to DESC
    LIMIT 25`;
  return { batch, context, users, facts, projects, recentTopics };
}

function involvedUserIds(batch: StoredMessage[], all: StoredMessage[], users: User[]): number[] {
  const ids = new Set<number>();
  const byMsgId = new Map(all.map((message) => [message.msg_id, message]));
  for (const message of batch) {
    if (message.user_id) ids.add(message.user_id);
    const repliedTo = message.reply_to_msg_id ? byMsgId.get(message.reply_to_msg_id) : undefined;
    if (repliedTo?.user_id) ids.add(repliedTo.user_id);
    for (const mention of message.text.matchAll(/@([A-Za-z0-9_]{4,})/g)) {
      const user = users.find((candidate) => candidate.username?.toLowerCase() === mention[1]!.toLowerCase());
      if (user) ids.add(user.id);
    }
  }
  return [...ids];
}

function formatMessage(message: StoredMessage, users: Map<number, User>): string {
  const author = message.user_id ? users.get(message.user_id) : undefined;
  const who = author ? `${author.display_name} (u${author.id})` : "неизвестный";
  const reply = message.reply_to_msg_id ? ` ↩${message.reply_to_msg_id}` : "";
  const forward = message.is_forward ? ` [переслано${message.forward_source ? ` из ${message.forward_source}` : ""}]` : "";
  const media = message.media_type ? ` [${message.media_type}]` : "";
  const text = truncate(message.text.replace(/\s+/g, " ").trim(), message.is_forward ? 300 : 1200);
  return `[${message.msg_id}] ${who}${reply}${forward}${media}: ${text}`;
}

export function buildExtractionPrompt(data: BatchData): string {
  const users = new Map(data.users.map((user) => [user.id, user]));
  const factsByUser = new Map<number, Fact[]>();
  for (const fact of data.facts) factsByUser.set(fact.user_id, [...(factsByUser.get(fact.user_id) ?? []), fact]);

  const people = data.users
    .filter((user) => !user.opted_out)
    .map((user) => {
      const facts = factsByUser.get(user.id) ?? [];
      const header = `u${user.id} | ${user.display_name}${user.username ? ` (@${user.username})` : ""}${user.tagline ? ` | ${user.tagline}` : " | без однострочника"}`;
      return facts.length ? `${header}\n${facts.map((fact) => `  [f${fact.id}] ${fact.kind}: ${fact.value}`).join("\n")}` : header;
    })
    .join("\n");
  const optedOut = data.users.filter((user) => user.opted_out).map((user) => `u${user.id}`);
  const projects = data.projects.length
    ? data.projects.map((project) => `${project.slug} | ${project.name} | ${project.status} | авторы: ${project.authors.join(", ") || "?"}`).join("\n")
    : "(пока пусто)";

  return [
    `<participants>\n${people}\n</participants>`,
    optedOut.length ? `<do_not_extract>Эти участники попросили ничего о них не собирать (факты и однострочники о них не пиши): ${optedOut.join(", ")}</do_not_extract>` : "",
    `<projects>\n${projects}\n</projects>`,
    data.recentTopics?.length
      ? `<recent_chronicle>\n${data.recentTopics.map((topic) => `• ${topic.title}`).join("\n")}\n</recent_chronicle>`
      : "",
    `<context>\n${data.context.map((message) => formatMessage(message, users)).join("\n") || "(нет)"}\n</context>`,
    `<new_messages>\n${data.batch.map((message) => formatMessage(message, users)).join("\n")}\n</new_messages>`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function parseRef(ref: string): number | null {
  const match = /^u?(\d+)$/.exec(ref.trim());
  return match ? Number(match[1]) : null;
}

export interface ApplyStats {
  topics: number;
  factsAdded: number;
  factsReinforced: number;
  factsSkipped: number;
  factsOutdated: number;
  factsUpdated: number;
  projectsCreated: number;
  projectsUpdated: number;
  signals: number;
  taglines: number;
}

export function emptyStats(): ApplyStats {
  return { topics: 0, factsAdded: 0, factsReinforced: 0, factsSkipped: 0, factsOutdated: 0, factsUpdated: 0, projectsCreated: 0, projectsUpdated: 0, signals: 0, taglines: 0 };
}

export async function applyExtraction(sql: Sql, runId: number, data: BatchData, result: ExtractionResult): Promise<ApplyStats> {
  const stats = emptyStats();
  const batchById = new Map(data.batch.map((message) => [message.msg_id, message]));
  const users = new Map(data.users.map((user) => [user.id, user]));
  const validSources = (ids: number[], max = 3) => ids.filter((id) => batchById.has(id)).slice(0, max);

  for (const topic of result.topics) {
    const msgIds = validSources(topic.msg_ids, 5);
    if (msgIds.length === 0 || hasForbiddenTopic(`${topic.title} ${topic.summary}`)) continue;
    const times = msgIds.map((id) => batchById.get(id)!.sent_at.getTime());
    const periodFrom = new Date(Math.min(...times));
    const periodTo = new Date(Math.max(...times));
    const userIds = [...new Set(msgIds.map((id) => batchById.get(id)?.user_id).filter((id): id is number => typeof id === "number"))];
    const first = Math.min(...msgIds);
    const last = Math.max(...msgIds);
    const [linked] = topic.project ? await sql<{ id: number }[]>`SELECT id FROM projects WHERE slug = ${slugify(topic.project)} AND NOT hidden` : [];
    const heat = data.batch.filter((message) => message.msg_id >= first && message.msg_id <= last && !message.is_forward).length + msgIds.length;
    await sql`
      INSERT INTO chronicle (run_id, period_from, period_to, title, summary, kind, msg_ids, user_ids, heat, importance, project_id)
      VALUES (${runId}, ${periodFrom}, ${periodTo}, ${truncate(topic.title.trim(), 120)}, ${truncate(topic.summary.trim(), 600)},
              ${topic.kind}, ${msgIds}, ${userIds}, ${heat}, ${Math.min(5, Math.max(1, Math.round(topic.importance)))}, ${linked?.id ?? null})`;
    stats.topics += 1;
  }

  for (const item of result.facts_add) {
    const userId = parseRef(item.person);
    const sources = validSources(item.source_msg_ids);
    if (userId === null || !users.has(userId) || sources.length === 0 || item.confidence < MIN_STORED_CONFIDENCE) {
      stats.factsSkipped += 1;
      continue;
    }
    const outcome = await proposeFact(sql, { userId, kind: item.kind, value: item.value, confidence: item.confidence, sourceMsgIds: sources, source: "llm" });
    if (outcome === "added") stats.factsAdded += 1;
    else if (outcome === "reinforced") stats.factsReinforced += 1;
    else stats.factsSkipped += 1;
  }

  const knownFactIds = new Set(data.facts.map((fact) => fact.id));
  for (const item of result.facts_outdated) {
    if (!knownFactIds.has(item.fact_id)) continue;
    if (await deprecateFact(sql, item.fact_id, validSources(item.source_msg_ids))) stats.factsOutdated += 1;
  }

  for (const item of result.facts_update) {
    if (!knownFactIds.has(item.fact_id)) continue;
    if (await rewriteFact(sql, item.fact_id, item.value, validSources(item.source_msg_ids), "llm")) stats.factsUpdated += 1;
  }

  for (const item of result.projects) {
    const sources = validSources(item.source_msg_ids);
    const authorIds = item.authors
      .map(parseRef)
      .filter((id): id is number => id !== null && users.has(id) && !users.get(id)!.opted_out);
    if (sources.length === 0 || authorIds.length === 0 || item.confidence < MIN_PROJECT_CONFIDENCE) continue;
    const activityAt = sources
      .map((id) => batchById.get(id)?.sent_at)
      .filter((date): date is Date => Boolean(date))
      .sort((a, b) => b.getTime() - a.getTime())[0];
    const { created } = await upsertProject(sql, {
      slug: item.slug,
      name: item.name,
      tagline: item.tagline,
      status: item.status,
      stack: item.stack,
      links: { repo: item.repo, site: item.site },
      authorIds,
      sourceMsgIds: sources,
      activityAt: activityAt ?? null,
      confidence: item.confidence,
      source: "llm",
    });
    if (created) stats.projectsCreated += 1;
    else stats.projectsUpdated += 1;
  }

  stats.signals += await applySignals(sql, runId, result, batchById, users);

  for (const item of result.taglines) {
    const userId = parseRef(item.person);
    const user = userId !== null ? users.get(userId) : undefined;
    if (!user || user.opted_out || user.tagline_manual || user.tagline || hasForbiddenTopic(item.tagline)) continue;
    await sql`UPDATE users SET tagline = ${truncate(item.tagline.trim(), 90)} WHERE id = ${user.id} AND tagline IS NULL AND NOT tagline_manual`;
    stats.taglines += 1;
  }

  return stats;
}

const SIGNAL_DEDUPE_DAYS = 7;

async function applySignals(
  sql: Sql,
  runId: number,
  result: ExtractionResult,
  batchById: Map<number, StoredMessage>,
  users: Map<number, User>,
): Promise<number> {
  let applied = 0;
  const seen = new Set<string>();
  for (const signal of result.project_signals) {
    const userId = parseRef(signal.person);
    const sources = signal.source_msg_ids.filter((id) => batchById.has(id)).slice(0, 3);
    if (userId === null || !users.has(userId) || sources.length === 0) continue;
    if (hasForbiddenTopic(signal.note)) continue;
    const [project] = await sql<{ id: number; is_author: boolean }[]>`
      SELECT p.id, EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = ${userId}) AS is_author
      FROM projects p WHERE p.slug = ${slugify(signal.project)} AND NOT p.hidden`;
    if (!project) continue;
    if (project.is_author !== (signal.kind === "milestone")) continue;
    const key = `${project.id}:${userId}:${signal.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const happenedAt = sources.map((id) => batchById.get(id)!.sent_at).sort((a, b) => b.getTime() - a.getTime())[0]!;
    const [recent] = await sql`
      SELECT 1 FROM project_signals
      WHERE project_id = ${project.id} AND user_id = ${userId} AND kind = ${signal.kind}
        AND happened_at > ${happenedAt}::timestamptz - ${`${SIGNAL_DEDUPE_DAYS} days`}::interval`;
    if (recent) continue;
    const impact = Math.min(5, Math.max(1, Math.round(signal.impact)));
    await sql`
      INSERT INTO project_signals (project_id, user_id, kind, impact, note, source_msg_ids, happened_at, run_id)
      VALUES (${project.id}, ${userId}, ${signal.kind}, ${impact}, ${truncate(signal.note.trim(), 240)}, ${sources}, ${happenedAt}, ${runId})`;
    if (signal.kind === "milestone") await sql`UPDATE projects SET last_activity_at = greatest(last_activity_at, ${happenedAt}) WHERE id = ${project.id}`;
    applied += 1;
  }
  return applied;
}

export async function callExtractor(anthropic: Anthropic, model: string, prompt: string): Promise<{ result: ExtractionResult; usage: Anthropic.Usage }> {
  const response = await anthropic.messages
    .stream({
      model,
      max_tokens: 32000,
      output_config: { effort: "low", format: zodOutputFormat(ExtractionSchema) },
      // No prompt caching: passes run hours apart, far beyond the cache TTL, so a cache write would only cost extra.
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    })
    .finalMessage();
  if (response.stop_reason === "refusal") throw new Error(`Extraction refused by the model: ${response.stop_details?.category ?? "no category"}`);
  if (response.stop_reason === "max_tokens") throw new Error("Extraction hit max_tokens");
  const text = response.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  const parsed = ExtractionSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`Model response does not match the schema: ${parsed.error.message}`);
  return { result: parsed.data, usage: response.usage };
}

export interface ExtractorDeps {
  sql: Sql;
  anthropic: Anthropic;
  config: Pick<Config, "CHAT_ID" | "EXTRACTION_MODEL" | "MONTHLY_LLM_BUDGET_USD">;
}

/** One pass = everything pending since the previous pass, normally in a single LLM call. */
export async function runExtractionPass(deps: ExtractorDeps): Promise<ApplyStats & { calls: number; messages: number }> {
  const { sql, anthropic, config } = deps;
  const [run] = await sql<{ id: number }[]>`INSERT INTO extraction_runs DEFAULT VALUES RETURNING id`;
  const runId = run!.id;
  const total = { ...emptyStats(), calls: 0, messages: 0 };
  let firstMsgId: number | null = null;
  let lastMsgId: number | null = null;

  try {
    for (let call = 0; call < MAX_CALLS_PER_PASS; call += 1) {
      const data = await loadBatch(sql, config.CHAT_ID, MAX_MESSAGES_PER_CALL);
      if (!data) break;
      const batchIds = data.batch.map((message) => message.msg_id);
      firstMsgId ??= batchIds[0]!;
      lastMsgId = batchIds[batchIds.length - 1]!;
      total.messages += batchIds.length;

      const meaningful = data.batch.some((message) => !message.is_forward && message.text.trim().length >= 3);
      if (meaningful) {
        await assertBudget(sql, config.MONTHLY_LLM_BUDGET_USD);
        const { result, usage } = await callExtractor(anthropic, config.EXTRACTION_MODEL, buildExtractionPrompt(data));
        await recordUsage(sql, "extract", config.EXTRACTION_MODEL, usage);
        total.calls += 1;
        const stats = await applyExtraction(sql, runId, data, result);
        for (const key of Object.keys(stats) as (keyof ApplyStats)[]) total[key] += stats[key];
      }
      await sql`UPDATE messages SET extracted_at = now() WHERE chat_id = ${config.CHAT_ID} AND msg_id = ANY(${batchIds})`;
    }
    await sql`
      UPDATE extraction_runs
      SET finished_at = now(), status = 'done', messages_count = ${total.messages},
          first_msg_id = ${firstMsgId}, last_msg_id = ${lastMsgId}, stats = ${sql.json({ ...total })}
      WHERE id = ${runId}`;
    return total;
  } catch (error) {
    await sql`
      UPDATE extraction_runs
      SET finished_at = now(), status = 'failed', messages_count = ${total.messages}, error = ${error instanceof Error ? error.message : String(error)}
      WHERE id = ${runId}`;
    throw error;
  }
}
