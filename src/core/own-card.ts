import type { User as TelegramUser } from "grammy/types";
import { aliasNorm, nameForms, namedIn, wordsOf, type Named } from "./aliases.js";
import type { Queryable, Sql } from "./db.js";
import { FACT_KINDS, type FactKind } from "./facts.js";
import { maskPersonalData } from "./privacy.js";
import { canonicalStackValue, splitStackValue } from "./stack.js";
import { hasForbiddenTopic, nameKey, normalizeValue, safeHttpUrl, transliterateName } from "./text.js";
import { SERVICE_TG_IDS, type User } from "./users.js";

/**
 * A member changes their own card by asking the bot. Whose card it is comes from Telegram's authenticated sender and
 * nothing else: Subject has one constructor, the operations name no person, and every write runs in asSubject, under
 * a database role that row-level security confines to that one member and chat (migrations/008_self_edits.sql).
 * Whatever a model or a message says, no other member's row can change on this path.
 */

declare const subjectBrand: unique symbol;
export interface Subject {
  readonly chatId: number;
  readonly userId: number;
  readonly tgId: number;
  readonly username: string | null;
  readonly [subjectBrand]: true;
}

/** The sender of a group message as the subject of their own edits; anything else throws. */
export function subjectOf(user: User, chatId: number, from: TelegramUser): Subject {
  if (user.tg_id === null || user.tg_id !== from.id || from.is_bot || SERVICE_TG_IDS.includes(from.id)) {
    throw new Error("only the sender of a message can be the subject of their own card edits");
  }
  return { chatId, userId: user.id, tgId: from.id, username: user.username } as Subject;
}

/** Runs `work` as the self-edit role, confined by row-level security to the subject's rows in the subject's chat. */
export async function asSubject<T>(sql: Sql, subject: Subject, work: (tx: Queryable) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE waggle_self_edit`;
    await tx`SELECT set_config('waggle.chat', ${String(subject.chatId)}, true), set_config('waggle.user', ${String(subject.userId)}, true)`;
    return work(tx);
  }) as Promise<T>;
}

export type OwnField = FactKind;

export type OwnOp =
  | { action: "add"; field: OwnField; value: string }
  | { action: "remove"; factId: number }
  | { action: "replace"; factId: number; field: OwnField; value: string }
  | { action: "set_tagline"; value: string }
  | { action: "clear_tagline" }
  | { action: "add_alias"; value: string }
  | { action: "remove_alias"; aliasId: number };

export interface OwnFact {
  id: number;
  kind: FactKind;
  value: string;
}

export interface OwnCard {
  facts: OwnFact[];
  aliases: { id: number; alias: string }[];
  tagline: string | null;
  optedOut: boolean;
}

/** The subject's own visible card: what they may name in a request. */
export async function ownCard(sql: Sql, subject: Subject): Promise<OwnCard> {
  const [facts, aliases, [member]] = await Promise.all([
    sql<OwnFact[]>`
      SELECT id, kind, value FROM facts
      WHERE chat_id = ${subject.chatId} AND user_id = ${subject.userId} AND status IN ('auto', 'manual')
      ORDER BY array_position(${[...FACT_KINDS]}::text[], kind), id`,
    sql<{ id: number; alias: string }[]>`SELECT id, alias FROM aliases WHERE chat_id = ${subject.chatId} AND user_id = ${subject.userId} ORDER BY id`,
    sql<{ tagline: string | null; opted_out: boolean }[]>`SELECT tagline, opted_out FROM members WHERE chat_id = ${subject.chatId} AND user_id = ${subject.userId}`,
  ]);
  return { facts, aliases, tagline: member?.tagline ?? null, optedOut: member?.opted_out ?? true };
}

/** One form of a text for every check: NFKC, no invisible or tag characters, collapsed spaces. */
export function cleanText(text: string): string {
  return text.normalize("NFKC").replace(/[\p{Cf}\u{E0000}-\u{E007F}]/gu, "").replace(/\s+/g, " ").trim();
}

const LATIN_LOOKALIKES: Record<string, string> = { a: "а", c: "с", e: "е", o: "о", p: "р", x: "х", y: "у", k: "к", m: "м", t: "т", h: "н", b: "в" };
const CYRILLIC_LOOKALIKES = Object.fromEntries(Object.entries(LATIN_LOOKALIKES).map(([latin, cyrillic]) => [cyrillic, latin]));

/** A word that mixes Latin and Cyrillic letters, read in the alphabet most of it is in («Kита» is «Кита»). */
export function foldMixedScript(text: string): string {
  return text.replace(/[\p{L}]+/gu, (word) => {
    const cyrillic = (word.match(/\p{Script=Cyrillic}/gu) ?? []).length;
    const latin = (word.match(/\p{Script=Latin}/gu) ?? []).length;
    if (!cyrillic || !latin) return word;
    const into = cyrillic >= latin ? LATIN_LOOKALIKES : CYRILLIC_LOOKALIKES;
    return [...word]
      .map((letter) => {
        const mapped = into[letter.toLowerCase()];
        return mapped === undefined ? letter : letter === letter.toLowerCase() ? mapped : mapped.toUpperCase();
      })
      .join("");
  });
}

/** Tech words people write in Cyrillic, and how the card spells them. */
const SLANG: Record<string, string> = {
  питон: "python", пайтон: "python", раст: "rust", го: "go", голанг: "go", джава: "java", ява: "java", котлин: "kotlin", свифт: "swift",
  тайпскрипт: "typescript", джаваскрипт: "javascript", жс: "javascript", реакт: "react", вью: "vue", ангуляр: "angular", нода: "node",
  докер: "docker", кубер: "kubernetes", линукс: "linux", руби: "ruby", рельсы: "rails", пхп: "php", сишарп: "c#", шарп: "c#", плюсы: "c++",
  клод: "claude", кодекс: "codex", курсор: "cursor", фигма: "figma", блендер: "blender", юнити: "unity", анрил: "unreal", зиг: "zig",
  эликсир: "elixir", скала: "scala", хаскель: "haskell", дарт: "dart", флаттер: "flutter", постгрес: "postgres", монга: "mongodb",
};

/** Every spelling of a word the sender might have used for it: as written, transliterated, or as tech slang. */
function variants(word: string): string[] {
  const lower = word.toLowerCase().replace(/ё/g, "е");
  const slang = SLANG[lower];
  const back = Object.entries(SLANG).filter(([, latin]) => latin === lower).map(([cyrillic]) => cyrillic);
  return [lower, ...(slang ? [slang] : []), ...back, ...transliterateName(lower).map((form) => form.toLowerCase())];
}

/** Whether every word of `value` is in the sender's own words, in some spelling or inflection. */
export function groundedIn(value: string, senderText: string): boolean {
  const said = new Set(wordsOf(foldMixedScript(senderText)).flatMap(variants));
  const stems = [...said].filter((word) => word.length >= 4).map((word) => word.slice(0, -1));
  return wordsOf(foldMixedScript(value)).every(
    (word) => variants(word).some((form) => said.has(form)) || (word.length >= 4 && stems.some((stem) => word.startsWith(stem))),
  );
}

/** Other members as names a value must not hold: their names, aliases and @usernames. */
export async function otherMembers(sql: Sql, subject: Subject): Promise<Named[]> {
  const people = await sql<{ id: number; display_name: string; username: string | null; aliases: string[] }[]>`
    SELECT u.id, u.display_name, u.username, coalesce(array_agg(a.alias) FILTER (WHERE a.alias IS NOT NULL), '{}') AS aliases
    FROM members m JOIN users u ON u.id = m.user_id
    LEFT JOIN aliases a ON a.chat_id = m.chat_id AND a.user_id = u.id
    WHERE m.chat_id = ${subject.chatId} AND u.id <> ${subject.userId}
    GROUP BY u.id`;
  return people.map((person) => ({ id: person.id, username: person.username, forms: nameForms(person.display_name, person.aliases) }));
}

/** Whether a text names another member, in either alphabet, with look-alike letters folded. */
export function namesSomeoneElse(text: string, others: Named[]): boolean {
  const folded = foldMixedScript(cleanText(text));
  const words = wordsOf(folded);
  const transliterated = words.flatMap((word) => transliterateName(word));
  return namedIn([folded, transliterated.join(" ")], others).length > 0 || /@[\p{L}\p{N}_]{3,}|t\.me\/|tg:\/\//iu.test(folded);
}

export type ValueProblem = "too_long" | "personal_data" | "forbidden" | "names_someone" | "not_their_words" | "bad_link";

const MAX_VALUE_CHARS = 120;
const MAX_VALUE_WORDS = 12;
const MAX_TAGLINE_CHARS = 90;
const MAX_ALIAS_CHARS = 40;

/** What is wrong with a value a member asked for, if anything: the same limits as a manual edit and then some. */
export function valueProblem(value: string, senderText: string, others: Named[], field: OwnField | "tagline" | "alias"): ValueProblem | null {
  const clean = cleanText(value);
  const limit = field === "tagline" ? MAX_TAGLINE_CHARS : field === "alias" ? MAX_ALIAS_CHARS : MAX_VALUE_CHARS;
  if (!clean || clean.length > limit || wordsOf(clean).length > MAX_VALUE_WORDS) return "too_long";
  if (maskPersonalData(clean) !== clean) return "personal_data";
  if (hasForbiddenTopic(clean)) return "forbidden";
  if (field === "link") return safeHttpUrl(clean.startsWith("http") ? clean : `https://${clean}`) ? null : "bad_link";
  if (namesSomeoneElse(clean, others)) return "names_someone";
  if (!groundedIn(clean, senderText)) return "not_their_words";
  return null;
}

/** Whether an alias would make the subject answer to a name that is someone else's, a project's or the bot's. */
export async function aliasTaken(sql: Sql, subject: Subject, alias: string, others: Named[], botNames: string[]): Promise<boolean> {
  const key = nameKey(alias);
  if (botNames.some((name) => nameKey(name) === key)) return true;
  if (others.some((other) => other.forms.some((form) => nameKey(form) === key) || (other.username && nameKey(other.username) === key))) return true;
  const [project] = await sql`
    SELECT 1 FROM projects WHERE chat_id = ${subject.chatId} AND NOT hidden AND (lower(name) = lower(${alias}) OR slug = ${key.replace(/\s+/g, "-")}) LIMIT 1`;
  return Boolean(project);
}

/** A write as it was done, with what it replaced, so the subject can undo it. */
export type Applied =
  | { kind: "fact_added"; factId: number; before: { status: string; value: string; confidence: number } | null; field: FactKind; value: string; unrejected: boolean }
  | { kind: "fact_removed"; row: FactRow }
  | { kind: "tagline"; before: { tagline: string | null; tagline_manual: boolean }; value: string | null }
  | { kind: "alias_added"; aliasId: number; value: string; unrejected: boolean }
  | { kind: "alias_removed"; row: AliasRow };

interface FactRow {
  id: number;
  chat_id: number;
  user_id: number;
  kind: FactKind;
  value: string;
  value_norm: string;
  confidence: number;
  status: string;
  source_msg_ids: number[];
}

interface AliasRow {
  id: number;
  chat_id: number;
  user_id: number;
  alias: string;
  alias_norm: string;
  source: string;
}

async function log(tx: Queryable, subject: Subject, entity: string, entityId: number, op: string, before: unknown, after: unknown, msgId: number): Promise<void> {
  await tx`
    INSERT INTO change_log (entity, entity_id, op, before, after, source, actor_user_id, source_msg_ids)
    VALUES (${entity}, ${entityId}, ${op}, ${before === null ? null : tx.json(before as never)}, ${after === null ? null : tx.json(after as never)}, 'user', ${subject.userId}, ${[msgId]})`;
}

async function addFact(tx: Queryable, subject: Subject, kind: FactKind, raw: string, msgId: number): Promise<Applied[]> {
  const parts = kind === "stack" ? splitStackValue(raw) : [raw];
  const applied: Applied[] = [];
  for (const part of parts) {
    const clean = cleanText(part);
    const link = kind === "link" ? safeHttpUrl(clean.startsWith("http") ? clean : `https://${clean}`) : null;
    const value = (kind === "stack" ? canonicalStackValue(part) : (link ?? clean)).slice(0, 160);
    const norm = normalizeValue(value);
    if (!norm) continue;
    const [before] = await tx<{ status: string; value: string; confidence: number }[]>`
      SELECT status, value, confidence FROM facts WHERE chat_id = ${subject.chatId} AND user_id = ${subject.userId} AND kind = ${kind} AND value_norm = ${norm}`;
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO facts (chat_id, user_id, kind, value, value_norm, confidence, status, source_msg_ids)
      VALUES (${subject.chatId}, ${subject.userId}, ${kind}, ${value}, ${norm}, 1, 'manual', ${[msgId]})
      ON CONFLICT (chat_id, user_id, kind, value_norm) DO UPDATE SET status = 'manual', value = excluded.value, confidence = 1, updated_at = now()
      RETURNING id`;
    const unrejected = (await tx`DELETE FROM rejected_facts WHERE chat_id = ${subject.chatId} AND user_id = ${subject.userId} AND kind = ${kind} AND value_norm = ${norm}`).count > 0;
    await log(tx, subject, "fact", row!.id, "add", before ?? null, { kind, value }, msgId);
    applied.push({ kind: "fact_added", factId: row!.id, before: before ?? null, field: kind, value, unrejected });
  }
  return applied;
}

async function removeFact(tx: Queryable, subject: Subject, factId: number, msgId: number): Promise<Applied[]> {
  const [row] = await tx<FactRow[]>`
    DELETE FROM facts WHERE id = ${factId} AND chat_id = ${subject.chatId} AND user_id = ${subject.userId}
    RETURNING id, chat_id, user_id, kind, value, value_norm, confidence, status, source_msg_ids`;
  if (!row) return [];
  await tx`
    INSERT INTO rejected_facts (chat_id, user_id, kind, value_norm) VALUES (${subject.chatId}, ${subject.userId}, ${row.kind}, ${row.value_norm})
    ON CONFLICT DO NOTHING`;
  await log(tx, subject, "fact", row.id, "reject", { kind: row.kind, value: row.value }, null, msgId);
  return [{ kind: "fact_removed", row }];
}

async function setTaglineOf(tx: Queryable, subject: Subject, value: string | null, msgId: number): Promise<Applied[]> {
  const [before] = await tx<{ tagline: string | null; tagline_manual: boolean }[]>`
    SELECT tagline, tagline_manual FROM members WHERE chat_id = ${subject.chatId} AND user_id = ${subject.userId}`;
  if (!before) return [];
  // A cleared tagline stays the person's choice: the chronicler does not write a new one over it.
  await tx`UPDATE members SET tagline = ${value}, tagline_manual = true WHERE chat_id = ${subject.chatId} AND user_id = ${subject.userId}`;
  await log(tx, subject, "user", subject.userId, "set_tagline", before, { tagline: value, chat_id: subject.chatId }, msgId);
  return [{ kind: "tagline", before, value }];
}

const ALIAS_STOP = "alias";

async function addOwnAlias(tx: Queryable, subject: Subject, raw: string, msgId: number): Promise<Applied[]> {
  const alias = cleanText(raw);
  const norm = aliasNorm(alias);
  const [row] = await tx<{ id: number }[]>`
    INSERT INTO aliases (chat_id, user_id, project_id, alias, alias_norm, source)
    VALUES (${subject.chatId}, ${subject.userId}, NULL, ${alias}, ${norm}, 'person')
    ON CONFLICT DO NOTHING RETURNING id`;
  const unrejected = (await tx`DELETE FROM rejected_facts WHERE chat_id = ${subject.chatId} AND user_id = ${subject.userId} AND kind = ${ALIAS_STOP} AND value_norm = ${norm}`).count > 0;
  if (!row) return [];
  await log(tx, subject, "alias", row.id, "add", null, { alias }, msgId);
  return [{ kind: "alias_added", aliasId: row.id, value: alias, unrejected }];
}

async function removeOwnAlias(tx: Queryable, subject: Subject, aliasId: number, msgId: number): Promise<Applied[]> {
  const [row] = await tx<AliasRow[]>`
    DELETE FROM aliases WHERE id = ${aliasId} AND chat_id = ${subject.chatId} AND user_id = ${subject.userId}
    RETURNING id, chat_id, user_id, alias, alias_norm, source`;
  if (!row) return [];
  // The chronicler does not bring a name back that its person took off.
  await tx`
    INSERT INTO rejected_facts (chat_id, user_id, kind, value_norm) VALUES (${subject.chatId}, ${subject.userId}, ${ALIAS_STOP}, ${row.alias_norm})
    ON CONFLICT DO NOTHING`;
  await log(tx, subject, "alias", row.id, "remove", { alias: row.alias }, null, msgId);
  return [{ kind: "alias_removed", row }];
}

/** Applies the operations to the subject's own card, all or nothing, and returns what was done. */
export async function applyOwnOps(sql: Sql, subject: Subject, ops: OwnOp[], msgId: number): Promise<Applied[]> {
  return asSubject(sql, subject, async (tx) => {
    const applied: Applied[] = [];
    for (const op of ops) {
      if (op.action === "add") applied.push(...(await addFact(tx, subject, op.field, op.value, msgId)));
      else if (op.action === "remove") applied.push(...(await removeFact(tx, subject, op.factId, msgId)));
      else if (op.action === "replace") {
        applied.push(...(await removeFact(tx, subject, op.factId, msgId)));
        applied.push(...(await addFact(tx, subject, op.field, op.value, msgId)));
      } else if (op.action === "set_tagline") applied.push(...(await setTaglineOf(tx, subject, cleanText(op.value), msgId)));
      else if (op.action === "clear_tagline") applied.push(...(await setTaglineOf(tx, subject, null, msgId)));
      else if (op.action === "add_alias") applied.push(...(await addOwnAlias(tx, subject, op.value, msgId)));
      else applied.push(...(await removeOwnAlias(tx, subject, op.aliasId, msgId)));
    }
    return applied;
  });
}

/** Undoes what applyOwnOps did, newest first, on the subject's own card only. */
export async function undoOwnOps(sql: Sql, subject: Subject, applied: Applied[], msgId: number): Promise<void> {
  await asSubject(sql, subject, async (tx) => {
    for (const change of [...applied].reverse()) {
      if (change.kind === "fact_added") {
        if (change.before) {
          await tx`
            UPDATE facts SET status = ${change.before.status}, value = ${change.before.value}, confidence = ${change.before.confidence}, updated_at = now()
            WHERE id = ${change.factId} AND chat_id = ${subject.chatId} AND user_id = ${subject.userId}`;
        } else {
          await tx`DELETE FROM facts WHERE id = ${change.factId} AND chat_id = ${subject.chatId} AND user_id = ${subject.userId}`;
        }
        if (change.unrejected) {
          await tx`
            INSERT INTO rejected_facts (chat_id, user_id, kind, value_norm) VALUES (${subject.chatId}, ${subject.userId}, ${change.field}, ${normalizeValue(change.value)})
            ON CONFLICT DO NOTHING`;
        }
      } else if (change.kind === "fact_removed") {
        const row = change.row;
        await tx`
          INSERT INTO facts (id, chat_id, user_id, kind, value, value_norm, confidence, status, source_msg_ids)
          VALUES (${row.id}, ${subject.chatId}, ${subject.userId}, ${row.kind}, ${row.value}, ${row.value_norm}, ${row.confidence}, ${row.status}, ${row.source_msg_ids})
          ON CONFLICT DO NOTHING`;
        await tx`DELETE FROM rejected_facts WHERE chat_id = ${subject.chatId} AND user_id = ${subject.userId} AND kind = ${row.kind} AND value_norm = ${row.value_norm}`;
      } else if (change.kind === "tagline") {
        await tx`
          UPDATE members SET tagline = ${change.before.tagline}, tagline_manual = ${change.before.tagline_manual}
          WHERE chat_id = ${subject.chatId} AND user_id = ${subject.userId}`;
      } else if (change.kind === "alias_added") {
        await tx`DELETE FROM aliases WHERE id = ${change.aliasId} AND chat_id = ${subject.chatId} AND user_id = ${subject.userId}`;
        if (change.unrejected) {
          await tx`
            INSERT INTO rejected_facts (chat_id, user_id, kind, value_norm) VALUES (${subject.chatId}, ${subject.userId}, ${ALIAS_STOP}, ${aliasNorm(change.value)})
            ON CONFLICT DO NOTHING`;
        }
      } else {
        const row = change.row;
        await tx`
          INSERT INTO aliases (id, chat_id, user_id, project_id, alias, alias_norm, source)
          VALUES (${row.id}, ${subject.chatId}, ${subject.userId}, NULL, ${row.alias}, ${row.alias_norm}, ${row.source})
          ON CONFLICT DO NOTHING`;
        await tx`DELETE FROM rejected_facts WHERE chat_id = ${subject.chatId} AND user_id = ${subject.userId} AND kind = ${ALIAS_STOP} AND value_norm = ${row.alias_norm}`;
      }
    }
    await log(tx, subject, "self_edit", msgId, "undo", null, null, msgId);
  });
}

/** Whether the chronicler may give a person this alias: not one they took off themselves. */
export async function aliasRejected(sql: Queryable, chatId: number, userId: number, alias: string): Promise<boolean> {
  const [row] = await sql`SELECT 1 FROM rejected_facts WHERE chat_id = ${chatId} AND user_id = ${userId} AND kind = ${ALIAS_STOP} AND value_norm = ${aliasNorm(alias)}`;
  return Boolean(row);
}
