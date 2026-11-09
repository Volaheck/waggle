import type { Queryable, Sql } from "./db.js";
import { hasForbiddenTopic, nameKey, transliterateName } from "./text.js";

/** Who gave the name: a bot owner, the person themselves (or a project's author), or the chronicler. */
export type AliasSource = "owner" | "person" | "chronicler";

export interface Alias {
  id: number;
  chat_id: number;
  user_id: number | null;
  project_id: number | null;
  alias: string;
  alias_norm: string;
  source: AliasSource;
  created_at: Date;
}

/** An alias with what it names: a member (display name, @username) or a project (name, slug). */
export interface NamedAlias extends Alias {
  display_name: string | null;
  username: string | null;
  project_name: string | null;
  project_slug: string | null;
}

export type AliasTarget = { userId: number } | { projectId: number };

export const MAX_ALIAS_LENGTH = 40;

/** Shorter names would match half the chat's words. */
const MIN_NAME_LETTERS = 3;

export type AddAliasOutcome = "added" | "exists" | "invalid" | "forbidden" | "opted_out";

/** Case, emoji, punctuation and Cyrillic letters that look Latin do not make another alias (see nameKey). */
export function aliasNorm(alias: string): string {
  return nameKey(alias);
}

export async function addAlias(sql: Queryable, input: { chatId: number; target: AliasTarget; alias: string; source: AliasSource }): Promise<AddAliasOutcome> {
  const alias = input.alias.replace(/\s+/g, " ").trim();
  const norm = aliasNorm(alias);
  if (!norm || alias.length > MAX_ALIAS_LENGTH) return "invalid";
  if (hasForbiddenTopic(alias)) return "forbidden";
  const userId = "userId" in input.target ? input.target.userId : null;
  const projectId = "projectId" in input.target ? input.target.projectId : null;
  if (userId !== null) {
    const [member] = await sql<{ opted_out: boolean }[]>`SELECT opted_out FROM members WHERE chat_id = ${input.chatId} AND user_id = ${userId}`;
    if (!member || member.opted_out) return "opted_out";
  }
  const inserted = await sql`
    INSERT INTO aliases (chat_id, user_id, project_id, alias, alias_norm, source)
    VALUES (${input.chatId}, ${userId}, ${projectId}, ${alias}, ${norm}, ${input.source})
    ON CONFLICT DO NOTHING`;
  return inserted.count > 0 ? "added" : "exists";
}

/** The chat's stored aliases of current members and shown projects, people first. */
export async function chatAliases(sql: Sql, chatId: number, options: { alias?: string } = {}): Promise<NamedAlias[]> {
  const norm = options.alias === undefined ? null : aliasNorm(options.alias);
  return sql<NamedAlias[]>`
    SELECT a.*, u.display_name, u.username, p.name AS project_name, p.slug AS project_slug
    FROM aliases a
    LEFT JOIN users u ON u.id = a.user_id
    LEFT JOIN members m ON m.chat_id = a.chat_id AND m.user_id = a.user_id
    LEFT JOIN projects p ON p.id = a.project_id
    WHERE a.chat_id = ${chatId} AND (${norm}::text IS NULL OR a.alias_norm = ${norm}::text)
      AND (a.user_id IS NULL OR (m.user_id IS NOT NULL AND m.left_at IS NULL)) AND (a.project_id IS NULL OR NOT p.hidden)
    ORDER BY a.user_id IS NULL, coalesce(u.display_name, p.name), a.id`;
}

/** The names a member goes by in the chat, oldest first: shown on their card, so anyone can see and correct them. */
export async function memberAliases(sql: Sql, chatId: number, userId: number): Promise<string[]> {
  const rows = await sql<{ alias: string }[]>`SELECT alias FROM aliases WHERE chat_id = ${chatId} AND user_id = ${userId} ORDER BY id`;
  return rows.map((row) => row.alias);
}

/**
 * Moves a chat's aliases to another chat id (a supergroup upgrade, attaching imported history): one the target
 * already has is not repeated, and none stays about a member who opted out on either side.
 */
export async function moveAliases(tx: Queryable, from: number, to: number): Promise<void> {
  await tx`
    UPDATE aliases a SET chat_id = ${to}
    WHERE a.chat_id = ${from}
      AND NOT EXISTS (
        SELECT 1 FROM aliases x
        WHERE x.chat_id = ${to} AND x.alias_norm = a.alias_norm
          AND coalesce(x.user_id, 0) = coalesce(a.user_id, 0) AND coalesce(x.project_id, 0) = coalesce(a.project_id, 0))`;
  await tx`DELETE FROM aliases WHERE chat_id = ${from}`;
  await tx`DELETE FROM aliases a USING members m WHERE a.chat_id = ${to} AND m.chat_id = ${to} AND m.user_id = a.user_id AND m.opted_out`;
}

export async function deleteAliases(sql: Sql, ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;
  return (await sql`DELETE FROM aliases WHERE id = ANY(${ids})`).count;
}

/**
 * The forms a name takes in a message: the whole display name, its first word, the aliases, and each of them in the
 * other alphabet («Gleb» is also «Глеб»).
 */
export function nameForms(displayName: string, aliases: string[] = []): string[] {
  const first = displayName.normalize("NFKC").split(/\s+/).find((part) => /\p{L}/u.test(part)) ?? "";
  const names = [displayName, first, ...aliases].map((name) => name.trim()).filter(Boolean);
  return [...new Set([...names, ...names.flatMap(transliterateName)])];
}

/** Lower-case words of a text, «ё» as «е»: what names are looked for in. */
export function wordsOf(text: string): string[] {
  return text.normalize("NFKC").toLowerCase().replace(/ё/g, "е").match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** The endings a Russian name takes in a sentence: «Глеба», «Тору», «с Машей», «об Анатолии». */
const CASE_ENDINGS = new Set(["", "а", "я", "у", "ю", "е", "и", "ы", "ой", "ей", "ою", "ею", "ом", "ем", "ам", "ям", "ами", "ями", "ах", "ях"]);

function wordIsName(word: string, name: string): boolean {
  if (word === name) return true;
  if (!/\p{Script=Cyrillic}/u.test(name)) return word === `${name}s`;
  const stem = name.length >= 3 && /[ая]$/u.test(name) ? name.slice(0, -1) : name.length >= 4 && /[йь]$/u.test(name) ? name.slice(0, -1) : name;
  return word.startsWith(stem) && CASE_ENDINGS.has(word.slice(stem.length));
}

/** Whether the words hold the name, inflected the way a Russian sentence would; a name of one or two letters never counts. */
export function mentionsName(words: string[], name: string): boolean {
  const parts = wordsOf(name);
  if (parts.join("").length < MIN_NAME_LETTERS) return false;
  for (let start = 0; start + parts.length <= words.length; start += 1) {
    if (parts.every((part, offset) => wordIsName(words[start + offset]!, part))) return true;
  }
  return false;
}

export function mentionsUsername(text: string, username: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}_])@${username}(?![\\p{L}\\p{N}_])`, "iu").test(text);
}

export interface Named {
  id: number;
  forms: string[];
  username?: string | null;
}

/** Who of `candidates` the texts name, in the order the texts come and then the order of the candidates. */
export function namedIn(texts: string[], candidates: Named[]): number[] {
  const found: number[] = [];
  for (const text of texts) {
    const words = wordsOf(text);
    for (const candidate of candidates) {
      if (found.includes(candidate.id)) continue;
      if ((candidate.username && mentionsUsername(text, candidate.username)) || candidate.forms.some((form) => mentionsName(words, form))) found.push(candidate.id);
    }
  }
  return found;
}

/**
 * Names that fit several people: a shared first name, someone's alias that is another member's name, a name and a
 * transliteration that read the same. Each comes with every spelling that leads to the same people.
 */
export function ambiguousNames(people: Named[]): { names: string[]; ids: number[] }[] {
  const byKey = new Map<string, { name: string; ids: Set<number> }>();
  for (const person of people) {
    for (const form of person.forms) {
      const key = nameKey(form);
      if (key.replace(/\s/g, "").length < MIN_NAME_LETTERS) continue;
      const entry = byKey.get(key) ?? { name: form, ids: new Set<number>() };
      entry.ids.add(person.id);
      byKey.set(key, entry);
    }
  }
  const groups = new Map<string, { names: string[]; ids: number[] }>();
  for (const { name, ids } of byKey.values()) {
    if (ids.size < 2) continue;
    const sorted = [...ids].sort((a, b) => a - b);
    const group = groups.get(sorted.join(",")) ?? { names: [], ids: sorted };
    group.names.push(name);
    groups.set(sorted.join(","), group);
  }
  return [...groups.values()];
}
