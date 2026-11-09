import type { Queryable, Sql } from "./db.js";
import { canonicalStackValue, splitStackValue, stackFamily } from "./stack.js";
import { hasForbiddenTopic, normalizeUrl, normalizeValue } from "./text.js";

export const FACT_KINDS = ["role", "stack", "expertise", "interest", "project", "link", "timezone", "looking_for", "can_help"] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export const FACT_KIND_LABELS: Record<FactKind, string> = {
  role: "Does",
  stack: "Stack",
  expertise: "Ask about",
  interest: "Interests",
  project: "Projects",
  link: "Links",
  timezone: "Where / time zone",
  looking_for: "Looking for",
  can_help: "Can help with",
};

export const MIN_VISIBLE_CONFIDENCE = 0.6;

export interface Fact {
  id: number;
  chat_id: number;
  user_id: number;
  kind: FactKind;
  value: string;
  confidence: number;
  status: "auto" | "manual" | "hidden" | "deprecated";
  source_msg_ids: number[];
  updated_at: Date;
}

export type FactSource = "llm" | "user" | "admin" | "seed";

export interface ProposedFact {
  chatId: number;
  userId: number;
  kind: FactKind;
  value: string;
  confidence: number;
  sourceMsgIds: number[];
  source: FactSource;
  actorUserId?: number;
}

export type ProposeResult = "added" | "reinforced" | "skipped_forbidden" | "skipped_rejected" | "skipped_opted_out" | "skipped_existing";

const CONFIDENCE_BOOST = 0.1;

const STOP_WORDS = new Set(["и", "в", "на", "для", "с", "по", "из", "от", "о", "а", "the", "a", "of", "for", "чипом", "через"]);

/** The essence of a fact: what comes before clarifications — «Codex (тариф Max)» → «codex». */
export function factCore(value: string): string {
  const head = value.split(/\s[—–-]\s|[(:;,]/)[0] ?? value;
  return normalizeValue(head);
}

function coreTokens(core: string): Set<string> {
  return new Set(core.split(" ").filter((token) => token && !STOP_WORDS.has(token)));
}

/**
 * Two facts say the same thing: equal cores, or (for multi-word cores) nearly the same words.
 * «Claude» and «Claude Code» stay different; «MacBook Pro M5» and «MacBook с чипом M5 Pro» merge.
 */
export function isNearDuplicate(a: string, b: string): boolean {
  if (normalizeValue(a) === normalizeValue(b)) return true;
  const coreA = factCore(a);
  const coreB = factCore(b);
  if (!coreA || !coreB) return false;
  if (coreA === coreB) return true;
  const tokensA = coreTokens(coreA);
  const tokensB = coreTokens(coreB);
  if (tokensA.size < 2 || tokensB.size < 2) return false;
  const shared = [...tokensA].filter((token) => tokensB.has(token)).length;
  return shared / Math.min(tokensA.size, tokensB.size) >= 0.75;
}

/** Same fact for a card: same tool family in the stack, otherwise the same meaning by wording. */
export function isSameFact(kind: string, a: string, b: string): boolean {
  if (kind === "stack") {
    const familyA = stackFamily(a);
    const familyB = stackFamily(b);
    if (familyA || familyB) return familyA?.key === familyB?.key;
  }
  return isNearDuplicate(a, b);
}

const RESULT_PRIORITY: ProposeResult[] = ["added", "reinforced", "skipped_existing", "skipped_rejected", "skipped_forbidden", "skipped_opted_out"];

type StoredFact = Fact & { value_norm: string };

interface FactOwner {
  chatId: number;
  userId: number;
  kind: string;
}

/** The person removed this fact as wrong («❌ Remove wrong»): nothing but the person may write it back, reworded or not. */
async function isRejected(sql: Queryable, owner: FactOwner, value: string): Promise<boolean> {
  const rejected = await sql<{ value_norm: string }[]>`
    SELECT value_norm FROM rejected_facts WHERE chat_id = ${owner.chatId} AND user_id = ${owner.userId} AND kind = ${owner.kind}`;
  return rejected.some((row) => isSameFact(owner.kind, row.value_norm, value));
}

function unionSources(...lists: number[][]): number[] {
  return [...new Set(lists.flat())].slice(-10);
}

export async function proposeFact(sql: Queryable, fact: ProposedFact): Promise<ProposeResult> {
  if (fact.kind === "stack") {
    const parts = splitStackValue(fact.value);
    if (parts.length > 1) {
      const results: ProposeResult[] = [];
      for (const part of parts) results.push(await proposeFact(sql, { ...fact, value: part }));
      return RESULT_PRIORITY.find((result) => results.includes(result)) ?? "skipped_existing";
    }
  }
  const value = (fact.kind === "stack" ? canonicalStackValue(fact.value) : fact.value.trim()).slice(0, 160);
  const valueNorm = normalizeValue(value);
  if (!valueNorm) return "skipped_existing";
  if (fact.source !== "user" && hasForbiddenTopic(value)) return "skipped_forbidden";

  return sql.begin(async (tx) => {
    const [owner] = await tx<{ opted_out: boolean }[]>`
      SELECT opted_out FROM members WHERE chat_id = ${fact.chatId} AND user_id = ${fact.userId} FOR UPDATE`;
    if (!owner || owner.opted_out) return "skipped_opted_out";

    if (fact.source !== "user" && (await isRejected(tx, fact, value))) return "skipped_rejected";

    if (fact.kind === "link") {
      const url = normalizeUrl(value)?.norm;
      const projectLinks = await tx<{ links: { repo?: string | null; site?: string | null; other?: string[] } }[]>`
        SELECT p.links FROM projects p JOIN project_members pm ON pm.project_id = p.id WHERE p.chat_id = ${fact.chatId} AND pm.user_id = ${fact.userId}`;
      const own = projectLinks.flatMap(({ links }) => [links.repo, links.site, ...(links.other ?? [])]).filter((link): link is string => Boolean(link));
      if (url && own.some((link) => normalizeUrl(link)?.norm === url)) return "skipped_existing";
    }

    const status = fact.source === "user" ? "manual" : "auto";
    const confidence = fact.source === "user" ? 1 : Math.min(Math.max(fact.confidence, 0), 1);
    const sameKind = await tx<Fact[]>`
      SELECT * FROM facts WHERE chat_id = ${fact.chatId} AND user_id = ${fact.userId} AND kind = ${fact.kind} AND status <> 'deprecated'`;
    const [existing] =
      (await tx<Fact[]>`SELECT * FROM facts WHERE chat_id = ${fact.chatId} AND user_id = ${fact.userId} AND kind = ${fact.kind} AND value_norm = ${valueNorm}`).concat(
        sameKind.filter((candidate) => isSameFact(fact.kind, candidate.value, value)),
      );

    if (existing) {
      if (existing.status === "hidden" && fact.source !== "user") return "skipped_existing";
      const mergedSources = unionSources(existing.source_msg_ids, fact.sourceMsgIds);
      const nextConfidence = Math.min(1, Math.max(existing.confidence, confidence) + (fact.source === "llm" ? CONFIDENCE_BOOST : 0));
      const nextStatus = fact.source === "user" ? "manual" : existing.status === "deprecated" ? "auto" : existing.status;
      // A person's own wording replaces the chronicler's; otherwise the existing wording stays.
      const nextValue = fact.source === "user" ? value : existing.value;
      await tx`
        UPDATE facts
        SET confidence = ${nextConfidence}, source_msg_ids = ${mergedSources}, status = ${nextStatus},
            value = ${nextValue}, value_norm = ${normalizeValue(nextValue)}, updated_at = now()
        WHERE id = ${existing.id}`;
      return "reinforced";
    }

    const [created] = await tx<{ id: number }[]>`
      INSERT INTO facts (chat_id, user_id, kind, value, value_norm, confidence, status, source_msg_ids)
      VALUES (${fact.chatId}, ${fact.userId}, ${fact.kind}, ${value}, ${valueNorm}, ${confidence}, ${status}, ${fact.sourceMsgIds})
      RETURNING id`;
    await tx`
      INSERT INTO change_log (entity, entity_id, op, after, source, actor_user_id, source_msg_ids)
      VALUES ('fact', ${created!.id}, 'add', ${tx.json({ chat_id: fact.chatId, user_id: fact.userId, kind: fact.kind, value, confidence })},
              ${fact.source}, ${fact.actorUserId ?? null}, ${fact.sourceMsgIds})`;
    return "added";
  });
}

export async function visibleFacts(sql: Sql, chatId: number, userId: number): Promise<Fact[]> {
  return sql<Fact[]>`
    SELECT * FROM facts
    WHERE chat_id = ${chatId} AND user_id = ${userId}
      AND (status = 'manual' OR (status = 'auto' AND confidence >= ${MIN_VISIBLE_CONFIDENCE}))
    ORDER BY array_position(${[...FACT_KINDS]}::text[], kind), status = 'manual' DESC, confidence DESC, id`;
}

export async function ownFacts(sql: Sql, chatId: number, userId: number): Promise<Fact[]> {
  return sql<Fact[]>`
    SELECT * FROM facts
    WHERE chat_id = ${chatId} AND user_id = ${userId} AND status <> 'deprecated'
    ORDER BY array_position(${[...FACT_KINDS]}::text[], kind), confidence DESC, id`;
}

export async function getFact(sql: Sql, factId: number): Promise<Fact | undefined> {
  const [fact] = await sql<Fact[]>`SELECT * FROM facts WHERE id = ${factId}`;
  return fact;
}

/** «❌ Remove wrong»: the fact disappears and the extractor may never bring it back. */
export async function rejectFact(sql: Sql, factId: number, actorUserId: number, source: FactSource): Promise<boolean> {
  return sql.begin(async (tx) => {
    const [fact] = await tx<(Fact & { value_norm: string })[]>`DELETE FROM facts WHERE id = ${factId} RETURNING *`;
    if (!fact) return false;
    await tx`
      INSERT INTO rejected_facts (chat_id, user_id, kind, value_norm) VALUES (${fact.chat_id}, ${fact.user_id}, ${fact.kind}, ${fact.value_norm})
      ON CONFLICT DO NOTHING`;
    await tx`
      INSERT INTO change_log (entity, entity_id, op, before, source, actor_user_id)
      VALUES ('fact', ${factId}, 'reject', ${tx.json({ kind: fact.kind, value: fact.value })}, ${source}, ${actorUserId})`;
    return true;
  });
}

/**
 * Hiding is about visibility, not authorship: the status a fact had before it was hidden is kept
 * in the change log and comes back on restore, so the person's own fact stays protected as theirs.
 */
export async function setFactHidden(sql: Queryable, factId: number, hidden: boolean, actorUserId: number, source: FactSource): Promise<boolean> {
  return sql.begin(async (tx) => {
    const [fact] = await tx<{ status: Fact["status"] }[]>`SELECT status FROM facts WHERE id = ${factId} FOR UPDATE`;
    if (!fact) return false;
    if (hidden) {
      if (fact.status !== "auto" && fact.status !== "manual") return false;
      await tx`UPDATE facts SET status = 'hidden', updated_at = now() WHERE id = ${factId}`;
      await tx`
        INSERT INTO change_log (entity, entity_id, op, before, source, actor_user_id)
        VALUES ('fact', ${factId}, 'hide', ${tx.json({ status: fact.status })}, ${source}, ${actorUserId})`;
      return true;
    }
    if (fact.status !== "hidden") return false;
    const restored = await statusBeforeHide(tx, factId);
    await tx`UPDATE facts SET status = ${restored}, updated_at = now() WHERE id = ${factId}`;
    await tx`
      INSERT INTO change_log (entity, entity_id, op, after, source, actor_user_id)
      VALUES ('fact', ${factId}, 'restore', ${tx.json({ status: restored })}, ${source}, ${actorUserId})`;
    return true;
  });
}

async function statusBeforeHide(sql: Queryable, factId: number): Promise<"auto" | "manual"> {
  const [hide] = await sql<{ status: string | null }[]>`
    SELECT before->>'status' AS status FROM change_log
    WHERE entity = 'fact' AND entity_id = ${factId} AND op = 'hide'
    ORDER BY id DESC LIMIT 1`;
  if (hide?.status === "auto" || hide?.status === "manual") return hide.status;
  // Hidden before the status was recorded: a fact the person added themselves is still theirs.
  const [own] = await sql`SELECT 1 FROM change_log WHERE entity = 'fact' AND entity_id = ${factId} AND op = 'add' AND source = 'user' LIMIT 1`;
  return own ? "manual" : "auto";
}

export async function deprecateFact(sql: Queryable, factId: number, sourceMsgIds: number[]): Promise<boolean> {
  const rows = await sql`
    UPDATE facts SET status = 'deprecated', updated_at = now()
    WHERE id = ${factId} AND status = 'auto'
    RETURNING id`;
  if (rows.length === 0) return false;
  await sql`
    INSERT INTO change_log (entity, entity_id, op, source, source_msg_ids)
    VALUES ('fact', ${factId}, 'deprecate', 'llm', ${sourceMsgIds})`;
  return true;
}

export interface ExpertHit {
  user_id: number;
  display_name: string;
  username: string | null;
  matches: string[];
}

/** «Who knows X» (/whoknows): members whose visible facts mention the topic (Russian stemming). */
export async function whoKnows(sql: Sql, chatId: number, topic: string, limit = 8): Promise<ExpertHit[]> {
  const words = topic.trim();
  if (!words) return [];
  return sql<ExpertHit[]>`
    WITH q AS (
      SELECT to_tsquery('russian', string_agg(quote_literal(lexeme) || ':*', ' | ')) AS query
      FROM (SELECT DISTINCT unnest(tsvector_to_array(to_tsvector('russian', ${words})))) AS t(lexeme)
    )
    SELECT u.id AS user_id, u.display_name, u.username, array_agg(f.value ORDER BY f.confidence DESC) AS matches
    FROM facts f JOIN users u ON u.id = f.user_id JOIN members m ON m.chat_id = f.chat_id AND m.user_id = f.user_id, q
    WHERE f.chat_id = ${chatId} AND q.query IS NOT NULL
      AND (to_tsvector('russian', f.value) @@ q.query OR f.value ILIKE '%' || ${words} || '%')
      AND f.kind IN ('stack', 'expertise', 'role', 'interest', 'can_help', 'project')
      AND (f.status = 'manual' OR (f.status = 'auto' AND f.confidence >= ${MIN_VISIBLE_CONFIDENCE}))
      AND NOT m.opted_out AND m.left_at IS NULL
    GROUP BY u.id
    ORDER BY count(*) DESC, max(f.confidence) DESC
    LIMIT ${limit}`;
}

/**
 * The chronicler rephrases a fact instead of adding a near-copy. Manual facts are the person's own words and stay.
 * Another row with the new wording decides by its status: a hidden one keeps the person's hide (nothing changes),
 * an outdated one gives way, a live one absorbs this fact.
 */
export async function rewriteFact(sql: Queryable, factId: number, value: string, sourceMsgIds: number[], source: FactSource): Promise<boolean> {
  return sql.begin(async (tx) => {
    const [fact] = await tx<StoredFact[]>`SELECT * FROM facts WHERE id = ${factId} FOR UPDATE`;
    if (!fact || fact.status !== "auto") return false;
    const next = (fact.kind === "stack" ? canonicalStackValue(value) : value.trim()).slice(0, 160);
    const nextNorm = normalizeValue(next);
    if (!nextNorm || nextNorm === fact.value_norm || hasForbiddenTopic(next)) return false;
    if (source !== "user" && (await isRejected(tx, { chatId: fact.chat_id, userId: fact.user_id, kind: fact.kind }, next))) return false;
    const [twin] = await tx<StoredFact[]>`
      SELECT * FROM facts
      WHERE chat_id = ${fact.chat_id} AND user_id = ${fact.user_id} AND kind = ${fact.kind} AND value_norm = ${nextNorm} AND id <> ${factId}
      FOR UPDATE`;
    if (twin?.status === "hidden") return false;
    if (twin && twin.status !== "deprecated") {
      await tx`DELETE FROM facts WHERE id = ${factId}`;
      if (twin.status === "auto") {
        await tx`
          UPDATE facts SET source_msg_ids = ${unionSources(twin.source_msg_ids, fact.source_msg_ids, sourceMsgIds)},
                 confidence = greatest(confidence, ${fact.confidence}), updated_at = now()
          WHERE id = ${twin.id}`;
      }
    } else {
      if (twin) await tx`DELETE FROM facts WHERE id = ${twin.id}`;
      await tx`
        UPDATE facts SET value = ${next}, value_norm = ${nextNorm}, source_msg_ids = ${unionSources(fact.source_msg_ids, sourceMsgIds)}, updated_at = now()
        WHERE id = ${factId}`;
    }
    await tx`
      INSERT INTO change_log (entity, entity_id, op, before, after, source, source_msg_ids)
      VALUES ('fact', ${factId}, 'rewrite', ${tx.json({ value: fact.value })}, ${tx.json({ value: next })}, ${source}, ${sourceMsgIds})`;
    return true;
  });
}

/**
 * Folds several facts of one person and one kind into one (keeps the first id). Manual facts are never
 * dropped or reworded; if one is in the group it becomes the keeper as is. Hidden and outdated facts
 * never take part, and a merge into a wording the person hid or removed as wrong does not happen.
 */
export async function mergeFacts(sql: Queryable, factIds: number[], value: string, source: FactSource): Promise<boolean> {
  if (factIds.length === 0) return false;
  return sql.begin(async (tx) => {
    const facts = await tx<StoredFact[]>`SELECT * FROM facts WHERE id = ANY(${factIds}) AND status IN ('auto', 'manual') ORDER BY id FOR UPDATE`;
    if (facts.length === 0 || new Set(facts.map((fact) => `${fact.chat_id}:${fact.user_id}:${fact.kind}`)).size > 1) return false;
    const manual = facts.find((fact) => fact.status === "manual");
    const keeper = manual ?? facts.find((fact) => fact.id === factIds[0]) ?? facts[0]!;
    const next = manual ? manual.value : (keeper.kind === "stack" ? canonicalStackValue(value) : value.trim()).slice(0, 160);
    const nextNorm = normalizeValue(next);
    if (!nextNorm) return false;
    const owner = { chatId: keeper.chat_id, userId: keeper.user_id, kind: keeper.kind };
    if (!manual && source !== "user" && (await isRejected(tx, owner, next))) return false;
    const [twin] = await tx<StoredFact[]>`
      SELECT * FROM facts
      WHERE chat_id = ${owner.chatId} AND user_id = ${owner.userId} AND kind = ${owner.kind} AND value_norm = ${nextNorm}
        AND id <> ALL(${facts.map((fact) => fact.id)})
      FOR UPDATE`;
    if (twin?.status === "hidden") return false;

    const others = facts.filter((fact) => fact.id !== keeper.id && fact.status !== "manual");
    const sources = unionSources(...facts.map((fact) => fact.source_msg_ids));
    const confidence = Math.max(...facts.map((fact) => fact.confidence));
    if (others.length) await tx`DELETE FROM facts WHERE id = ANY(${others.map((fact) => fact.id)})`;
    if (twin?.status === "deprecated") await tx`DELETE FROM facts WHERE id = ${twin.id}`;
    const absorbing = twin && twin.status !== "deprecated" ? twin : undefined;
    if (absorbing) {
      // A live fact outside the group already says it: the group folds into that fact.
      if (keeper.status !== "manual") await tx`DELETE FROM facts WHERE id = ${keeper.id}`;
      if (absorbing.status === "auto") {
        await tx`
          UPDATE facts SET source_msg_ids = ${unionSources(absorbing.source_msg_ids, sources)}, confidence = greatest(confidence, ${confidence}), updated_at = now()
          WHERE id = ${absorbing.id}`;
      }
    } else {
      await tx`
        UPDATE facts SET value = ${next}, value_norm = ${nextNorm}, source_msg_ids = ${sources}, confidence = ${confidence}, updated_at = now()
        WHERE id = ${keeper.id}`;
    }
    await tx`
      INSERT INTO change_log (entity, entity_id, op, before, after, source)
      VALUES ('fact', ${absorbing?.id ?? keeper.id}, 'merge', ${tx.json(facts.map((fact) => fact.value))}, ${tx.json({ value: next })}, ${source})`;
    return true;
  });
}

/** Removes a fact as redundant (not as wrong): no stop-list entry, unlike rejectFact. The person's own and hidden facts stay. */
export async function dropFact(sql: Queryable, factId: number, source: FactSource): Promise<boolean> {
  const rows = await sql<{ value: string }[]>`DELETE FROM facts WHERE id = ${factId} AND status IN ('auto', 'deprecated') RETURNING value`;
  if (rows.length === 0) return false;
  await sql`INSERT INTO change_log (entity, entity_id, op, before, source) VALUES ('fact', ${factId}, 'drop', ${sql.json({ value: rows[0]!.value })}, ${source})`;
  return true;
}

/**
 * Deterministic clean-up of stacks: splits «A, B» facts and folds tools of one family
 * («GPT-6», «ChatGPT», «Codex») into a single fact. Runs before every LLM clean-up.
 * Hidden facts are left exactly as the person hid them.
 */
export async function normalizeStacks(sql: Sql, chatId?: number): Promise<{ split: number; merged: number }> {
  const scope = chatId ?? null;
  let split = 0;
  let merged = 0;
  const combined = await sql<Fact[]>`SELECT * FROM facts WHERE kind = 'stack' AND status IN ('auto', 'manual') AND (${scope}::bigint IS NULL OR chat_id = ${scope}::bigint)`;
  for (const fact of combined) {
    const parts = splitStackValue(fact.value);
    if (parts.length < 2) continue;
    // Remove the combined fact first, or each part would be folded back into it.
    await sql`DELETE FROM facts WHERE id = ${fact.id}`;
    for (const part of parts) {
      await proposeFact(sql, { chatId: fact.chat_id, userId: fact.user_id, kind: "stack", value: part, confidence: fact.confidence, sourceMsgIds: fact.source_msg_ids, source: fact.status === "manual" ? "user" : "llm" });
    }
    split += 1;
  }
  const facts = await sql<Fact[]>`SELECT * FROM facts WHERE kind = 'stack' AND status IN ('auto', 'manual') AND (${scope}::bigint IS NULL OR chat_id = ${scope}::bigint) ORDER BY chat_id, user_id, status = 'manual' DESC, confidence DESC, id`;
  const groups = new Map<string, Fact[]>();
  for (const fact of facts) {
    const family = stackFamily(fact.value);
    if (!family) continue;
    const key = `${fact.chat_id}:${fact.user_id}:${family.key}`;
    groups.set(key, [...(groups.get(key) ?? []), fact]);
  }
  for (const group of groups.values()) {
    const label = stackFamily(group[0]!.value)!.label;
    if (group.length === 1 && group[0]!.value === label) continue;
    if (group.length === 1 && group[0]!.status === "manual") continue;
    if (await mergeFacts(sql, group.map((fact) => fact.id), label, "llm")) merged += group.length;
  }
  return { split, merged };
}
