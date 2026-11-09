import type { Sql } from "./db.js";
import { stackFamily } from "./stack.js";

/**
 * Recurring themes: the arguments the same people keep coming back to, and the chat's running jokes. Plain SQL and a
 * little clustering, no model: the answer context and the bot's own interjections read them.
 */

/**
 * Tools and products as Postgres's Russian configuration stems them, in both alphabets: «клода» → 'клод' but «Claude» →
 * 'claud', and «телеграм» → 'телегр' but «телеграма» → 'телеграм'. Each stem leads to one Latin name, so the spellings meet.
 */
const PRODUCT_LEXEMES: Record<string, string> = {
  claud: "claude", claudecod: "claude", клод: "claude",
  codex: "codex", кодекс: "codex",
  gpt: "gpt", chatgpt: "gpt", гпт: "gpt", жпт: "gpt", чатгпт: "gpt", чатжпт: "gpt",
  sonnet: "sonnet", сонет: "sonnet",
  opus: "opus", опус: "opus",
  haiku: "haiku", хайк: "haiku",
  anthrop: "anthropic", антропик: "anthropic",
  openai: "openai", опена: "openai",
  gemini: "gemini", гемин: "gemini", джемин: "gemini",
  cursor: "cursor", курсор: "cursor",
  kimi: "kimi", ким: "kimi",
  deepseek: "deepseek", дипсик: "deepseek",
  grok: "grok", грок: "grok",
  qwen: "qwen", квен: "qwen",
  perplex: "perplexity", перплексит: "perplexity",
  telegram: "telegram", телегр: "telegram", телеграм: "telegram", телеграмм: "telegram", телег: "telegram",
  github: "github", гитхаб: "github",
  rust: "rust", раст: "rust",
  go: "go", golang: "go",
  python: "python", питон: "python",
  // «ИИ» is stemmed to a lone 'и'; the conjunction never reaches a tsvector, being a stop word.
  ai: "ai", и: "ai",
  llm: "llm", ллм: "llm",
};

/** Words that set the two sides of a title against each other rather than say what it is about. */
const LINKING_LEXEMES = new Set(["vs", "versus", "прот"]);

/**
 * What a lexeme counts as when themes are compared: a tool or product in either alphabet becomes one Latin name, and a
 * vendor's tools their family in stack.ts («клод», «Opus» and «Claude» are all anthropic), so the same argument meets
 * itself whatever names it is held in. Numbers, fragments of one or two letters and hyphenated compounds count for nothing.
 */
export function canonicalTerm(lexeme: string): string | null {
  const product = PRODUCT_LEXEMES[lexeme];
  if (product) return stackFamily(product)?.key ?? product;
  if (lexeme.length < 3 || lexeme.includes("-") || /^[\d.,]+$/.test(lexeme) || LINKING_LEXEMES.has(lexeme)) return null;
  return /^[a-z][a-z0-9.]*$/.test(lexeme) ? (stackFamily(lexeme)?.key ?? lexeme) : lexeme;
}

export function termsOf(lexemes: string[]): string[] {
  return [...new Set(lexemes.map(canonicalTerm).filter((term): term is string => term !== null))];
}

/** The terms of each text, from Postgres's Russian stemming, in the order of the texts. */
export async function textTerms(sql: Sql, texts: string[]): Promise<string[][]> {
  if (texts.length === 0) return [];
  const rows = await sql<{ lexemes: string[] }[]>`
    SELECT tsvector_to_array(to_tsvector('russian', listed.text)) AS lexemes
    FROM unnest(${texts}::text[]) WITH ORDINALITY AS listed(text, position)
    ORDER BY listed.position`;
  return rows.map((row) => termsOf(row.lexemes));
}

export interface ThemeTopic {
  id: number;
  title: string;
  summary: string;
  kind: string;
  period_to: Date;
  user_ids: number[];
  terms: string[];
}

export interface Theme {
  /** Stays the same as the theme grows: its oldest topic (t12), or the first version of a running joke (b7). */
  key: string;
  kind: "debate" | "bit";
  title: string;
  /** Terms found in at least two of its topics; a running joke's are those of its note. */
  keywords: string[];
  /** Everyone who took part, the most frequent first. */
  userIds: number[];
  /** Oldest first; a running joke has none. */
  topics: ThemeTopic[];
  /** A running joke's current note. */
  note?: { id: number; about: string | null; value: string; said_at: Date | null };
}

const THEME_DAYS = 180;
const HOT_DISCUSSION_HEAT = 40;
const MIN_SHARED_TERMS = 2;
const MIN_SHARED_PEOPLE = 2;
const MIN_THEME_DAYS = 2;
/** Far more than a chat argues about in half a year; it bounds the pairwise comparison. */
const MAX_TOPICS = 600;

function shared<T>(a: readonly T[], b: readonly T[]): number {
  const other = new Set(b);
  return a.filter((item) => other.has(item)).length;
}

/** Connected groups: `linked` items end up in one group, directly or through others. */
function groupsOf<T>(items: T[], linked: (a: T, b: T) => boolean): T[][] {
  const parent = items.map((_, index) => index);
  const root = (index: number): number => {
    while (parent[index] !== index) index = parent[index] = parent[parent[index]!]!;
    return index;
  };
  for (let a = 0; a < items.length; a += 1) {
    for (let b = a + 1; b < items.length; b += 1) if (linked(items[a]!, items[b]!)) parent[root(a)] = root(b);
  }
  const groups = new Map<number, T[]>();
  items.forEach((item, index) => groups.set(root(index), [...(groups.get(root(index)) ?? []), item]));
  return [...groups.values()];
}

function byFrequency<T>(lists: T[][]): T[] {
  const counts = new Map<T, number>();
  for (const item of lists.flat()) counts.set(item, (counts.get(item) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([item]) => item);
}

/**
 * The chat's recurring themes. Topics of the last THEME_DAYS days that are debates, or discussions of two or more people
 * with a heat of HOT_DISCUSSION_HEAT or more, belong together when their titles share MIN_SHARED_TERMS terms and they
 * share MIN_SHARED_PEOPLE participants; a group that spans MIN_THEME_DAYS days or more is a theme, newest first.
 * Every current running joke (a bit note) is a theme too.
 */
export async function recurringThemes(sql: Sql, chatId: number): Promise<Theme[]> {
  const [rows, bits] = await Promise.all([
    sql<(Omit<ThemeTopic, "terms"> & { lexemes: string[] })[]>`
      SELECT id, title, summary, kind, period_to, user_ids, tsvector_to_array(to_tsvector('russian', title)) AS lexemes
      FROM chronicle
      WHERE chat_id = ${chatId} AND period_to > now() - ${`${THEME_DAYS} days`}::interval
        AND (kind = 'debate' OR (kind = 'discussion' AND cardinality(user_ids) >= ${MIN_SHARED_PEOPLE} AND heat >= ${HOT_DISCUSSION_HEAT}))
      ORDER BY period_to DESC, id DESC
      LIMIT ${MAX_TOPICS}`,
    sql<{ id: number; about: string | null; value: string; user_ids: number[]; said_at: Date | null; superseded_by: number | null; lexemes: string[] }[]>`
      SELECT id, about, value, user_ids, said_at, superseded_by, tsvector_to_array(tsv) AS lexemes
      FROM notes WHERE chat_id = ${chatId} AND kind = 'bit'`,
  ]);

  const topics: ThemeTopic[] = rows.map(({ lexemes, ...topic }) => ({ ...topic, terms: termsOf(lexemes) }));
  const debates = groupsOf(topics, (a, b) => shared(a.terms, b.terms) >= MIN_SHARED_TERMS && shared(a.user_ids, b.user_ids) >= MIN_SHARED_PEOPLE)
    .map((group) => group.sort((a, b) => a.period_to.getTime() - b.period_to.getTime() || a.id - b.id))
    .filter((group) => new Set(group.map((topic) => topic.period_to.toISOString().slice(0, 10))).size >= MIN_THEME_DAYS)
    .map((group): Theme => {
      const counts = byFrequency(group.map((topic) => topic.terms));
      return {
        key: `t${Math.min(...group.map((topic) => topic.id))}`,
        kind: "debate",
        title: group.at(-1)!.title,
        keywords: counts.filter((term) => group.filter((topic) => topic.terms.includes(term)).length >= 2),
        userIds: byFrequency(group.map((topic) => topic.user_ids)),
        topics: group,
      };
    })
    .sort((a, b) => b.topics.at(-1)!.period_to.getTime() - a.topics.at(-1)!.period_to.getTime());

  // A joke's key is its first version, so a new twist does not make it another theme.
  const earlier = new Map<number, number[]>();
  for (const bit of bits) if (bit.superseded_by !== null) earlier.set(bit.superseded_by, [...(earlier.get(bit.superseded_by) ?? []), bit.id]);
  const firstVersion = (id: number): number => {
    let first = id;
    const queue = [id];
    const seen = new Set<number>();
    while (queue.length) {
      const next = queue.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      first = Math.min(first, next);
      queue.push(...(earlier.get(next) ?? []));
    }
    return first;
  };
  const jokes = bits
    .filter((bit) => bit.superseded_by === null)
    .sort((a, b) => (b.said_at?.getTime() ?? 0) - (a.said_at?.getTime() ?? 0))
    .map(
      (bit): Theme => ({
        key: `b${firstVersion(bit.id)}`,
        kind: "bit",
        title: bit.about ?? bit.value,
        keywords: termsOf(bit.lexemes),
        userIds: bit.user_ids,
        topics: [],
        note: { id: bit.id, about: bit.about, value: bit.value, said_at: bit.said_at },
      }),
    );
  return [...debates, ...jokes];
}

/**
 * The themes that share at least `minShared` keywords with the terms, the most shared first; with `userIds`, only those
 * at least one of whose people is among them.
 */
export function themesMatching(themes: Theme[], terms: Iterable<string>, options: { minShared?: number; userIds?: number[] } = {}): { theme: Theme; shared: string[] }[] {
  const wanted = new Set(terms);
  return themes
    .filter((theme) => !options.userIds || theme.userIds.some((id) => options.userIds!.includes(id)))
    .map((theme) => ({ theme, shared: theme.keywords.filter((keyword) => wanted.has(keyword)) }))
    .filter((match) => match.shared.length >= (options.minShared ?? 3))
    .sort((a, b) => b.shared.length - a.shared.length);
}
