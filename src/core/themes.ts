import type { Sql } from "./db.js";
import { stackFamily } from "./stack.js";

/**
 * Recurring themes: what the chat keeps coming back to, as the model grouped it from the chronicle once a day
 * (worker/themes-index.ts), and the chat's running jokes. The answer context and the bot's own interjections read them;
 * a live conversation is matched to one by the terms they share.
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

/**
 * Each word's term as textTerms counts it; none for a stop word or a fragment. A Latin word the stemming cuts below
 * three letters («iOS» → 'io') stays whole.
 */
export async function wordTerms(sql: Sql, words: string[]): Promise<Map<string, string>> {
  if (words.length === 0) return new Map();
  const rows = await sql<{ word: string; lexemes: string[] }[]>`
    SELECT listed.word, tsvector_to_array(to_tsvector('russian', listed.word)) AS lexemes FROM unnest(${words}::text[]) AS listed(word)`;
  const terms = new Map<string, string>();
  for (const row of rows) {
    const term = termsOf(row.lexemes)[0] ?? (row.lexemes.length && /^[a-z][a-z0-9]{2,}$/.test(row.word) ? row.word : undefined);
    if (term) terms.set(row.word, term);
  }
  return terms;
}

export interface ThemeTopic {
  id: number;
  title: string;
  summary: string;
  kind: string;
  period_to: Date;
  user_ids: number[];
}

export interface Theme {
  /** Stays the same as the theme grows: its oldest topic (t12), or the first version of a running joke (b7). */
  key: string;
  /** "debate" for anything the chat keeps coming back to, an argument or a long-running subject. */
  kind: "debate" | "bit";
  title: string;
  /** The terms of the words that bring it up; a running joke's are those of its name. */
  keywords: string[];
  /** Everyone who took part, the most frequent first. */
  userIds: number[];
  /** Oldest first; a running joke has none. */
  topics: ThemeTopic[];
  /** A running joke's current note. */
  note?: { id: number; about: string | null; value: string; said_at: Date | null };
}

function byFrequency<T>(lists: T[][]): T[] {
  const counts = new Map<T, number>();
  for (const item of lists.flat()) counts.set(item, (counts.get(item) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([item]) => item);
}

/**
 * The chat's recurring themes, the latest first: the ones the model grouped from the chronicle that still have two
 * topics or more, then every current running joke (a bit note), known by its name.
 */
export async function recurringThemes(sql: Sql, chatId: number): Promise<Theme[]> {
  const [stored, bits] = await Promise.all([
    sql<{ title: string; topic_ids: number[]; lexemes: string[] }[]>`
      SELECT title, topic_ids, tsvector_to_array(to_tsvector('russian', array_to_string(keywords, ' '))) AS lexemes
      FROM themes WHERE chat_id = ${chatId} ORDER BY id`,
    sql<{ id: number; about: string | null; value: string; user_ids: number[]; said_at: Date | null; superseded_by: number | null; lexemes: string[] }[]>`
      SELECT id, about, value, user_ids, said_at, superseded_by, tsvector_to_array(to_tsvector('russian', coalesce(about, value))) AS lexemes
      FROM notes WHERE chat_id = ${chatId} AND kind = 'bit'`,
  ]);

  const topicIds = stored.flatMap((theme) => theme.topic_ids);
  const topics = topicIds.length
    ? await sql<ThemeTopic[]>`SELECT id, title, summary, kind, period_to, user_ids FROM chronicle WHERE chat_id = ${chatId} AND id = ANY(${topicIds}::int[])`
    : [];
  const topicById = new Map(topics.map((topic) => [topic.id, topic]));
  const debates = stored
    .flatMap((theme): Theme[] => {
      const own = theme.topic_ids
        .flatMap((id) => (topicById.has(id) ? [topicById.get(id)!] : []))
        .sort((a, b) => a.period_to.getTime() - b.period_to.getTime() || a.id - b.id);
      if (own.length < 2) return [];
      return [
        {
          key: `t${Math.min(...own.map((topic) => topic.id))}`,
          kind: "debate",
          title: theme.title,
          keywords: termsOf(theme.lexemes),
          userIds: byFrequency(own.map((topic) => topic.user_ids)),
          topics: own,
        },
      ];
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
 * The themes that share at least `minShared` keywords with the terms, the most shared first. A theme with fewer
 * keywords needs all of them, and never fewer than two: a running joke is brought up by its two-word name, never by
 * one word. With `userIds`, only the themes at least one of whose people is among them.
 */
export function themesMatching(themes: Theme[], terms: Iterable<string>, options: { minShared?: number; userIds?: number[] } = {}): { theme: Theme; shared: string[] }[] {
  const wanted = new Set(terms);
  const needed = (theme: Theme) => Math.max(2, Math.min(options.minShared ?? 3, theme.keywords.length));
  return themes
    .filter((theme) => !options.userIds || theme.userIds.some((id) => options.userIds!.includes(id)))
    .map((theme) => ({ theme, shared: theme.keywords.filter((keyword) => wanted.has(keyword)) }))
    .filter((match) => match.shared.length >= needed(match.theme))
    .sort((a, b) => b.shared.length - a.shared.length);
}
