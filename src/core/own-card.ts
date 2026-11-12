import type { User as TelegramUser } from "grammy/types";
import { aliasNorm, nameForms, namedIn, wordsOf, type Named } from "./aliases.js";
import type { Queryable, Sql } from "./db.js";
import { FACT_KINDS, type FactKind } from "./facts.js";
import { MAX_MEMO_CHARS, MAX_MEMOS } from "./memos.js";
import { maskPersonalData } from "./privacy.js";
import { editProject, MAX_PROJECT_TAGLINE_CHARS, MAX_STACK_ITEM_CHARS, PROJECT_STATUSES, type EditableValues, type ProjectEdit, type ProjectFields, type ProjectStatus } from "./projects.js";
import { canonicalStackValue, splitStackValue } from "./stack.js";
import { hasForbiddenTopic, nameKey, normalizeValue, safeHttpUrl, transliterateName } from "./text.js";
import { SERVICE_TG_IDS, type User } from "./users.js";
import type { ChosenSource } from "./zones.js";

/**
 * A member changes their own card by asking the bot, and a project's author that project's entry. Whose card it is
 * comes from Telegram's authenticated sender and nothing else: Subject has one constructor, the operations name no
 * person, and every write runs in asSubject, under a database role that row-level security confines to that one member
 * and chat (migrations/008_self_edits.sql), and on projects to those the member is an author of
 * (migrations/015_project_edits.sql). Whatever a model or a message says, no other member's row and no one else's
 * project can change on this path.
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
  | { action: "add"; field: OwnField; value: string; zones?: string[] }
  | { action: "remove"; factId: number }
  | { action: "replace"; factId: number; field: OwnField; value: string; zones?: string[] }
  | { action: "set_tagline"; value: string }
  | { action: "clear_tagline" }
  | { action: "add_alias"; value: string }
  | { action: "remove_alias"; aliasId: number }
  /** `pick`: a note on one of their projects that they did not name; it waits for them to pick which. */
  | { action: "add_memo"; projectId: number | null; projectName: string | null; text: string; pick?: true }
  | { action: "remove_memo"; memoId: number; projectName: string | null }
  | { action: "set_zone"; zone: string; place: string }
  | { action: "clear_zone" }
  | { action: "edit_project"; projectId: number; projectName: string; change: ProjectChange };

/** A project's entry as a request in the chat changes it: each of its two links on its own. */
export interface ProjectSlots {
  tagline: string | null;
  status: ProjectStatus;
  stack: string[];
  repo: string | null;
  site: string | null;
}

/** What a request asks of one project: a slot left out stays as it is, and a link set to null comes off. */
export interface ProjectChange {
  tagline?: string;
  status?: ProjectStatus;
  stackAdd?: string[];
  stackRemove?: string[];
  repo?: string | null;
  site?: string | null;
  /**
   * Set by an Undo for its Redo: a slot named here changes only while it still holds this value, the one the Undo put
   * back, so what a co-author set since stays.
   */
  from?: Partial<Pick<ProjectSlots, "tagline" | "status" | "repo" | "site">>;
}

/** A project the subject is an author of, as their card lists it. */
export interface OwnProject extends ProjectSlots {
  id: number;
  name: string;
  /** Its other authors: a value written on it may name them. */
  coauthor_ids: number[];
}

export interface OwnFact {
  id: number;
  kind: FactKind;
  value: string;
}

export interface OwnMemo {
  id: number;
  project_id: number | null;
  project_name: string | null;
  text: string;
}

export interface OwnCard {
  facts: OwnFact[];
  aliases: { id: number; alias: string }[];
  tagline: string | null;
  optedOut: boolean;
  /** Their notes, about themselves and about their projects. */
  memos: OwnMemo[];
  /** The projects they are an author of: the only ones they may write a note on or change. */
  projects: OwnProject[];
  /** The time zone they chose or their device gave, if any. */
  zone: { zone: string; source: ChosenSource } | null;
}

/** The subject's own visible card: what they may name in a request. */
export async function ownCard(sql: Sql, subject: Subject): Promise<OwnCard> {
  const [facts, aliases, [member], memos, projects] = await Promise.all([
    sql<OwnFact[]>`
      SELECT id, kind, value FROM facts
      WHERE chat_id = ${subject.chatId} AND user_id = ${subject.userId} AND status IN ('auto', 'manual')
      ORDER BY array_position(${[...FACT_KINDS]}::text[], kind), id`,
    sql<{ id: number; alias: string }[]>`SELECT id, alias FROM aliases WHERE chat_id = ${subject.chatId} AND user_id = ${subject.userId} ORDER BY id`,
    sql<{ tagline: string | null; opted_out: boolean; time_zone: string | null; time_zone_source: ChosenSource | null }[]>`
      SELECT tagline, opted_out, time_zone, time_zone_source FROM members WHERE chat_id = ${subject.chatId} AND user_id = ${subject.userId}`,
    sql<OwnMemo[]>`
      SELECT n.id, n.project_id, p.name AS project_name, n.text FROM memos n LEFT JOIN projects p ON p.id = n.project_id
      WHERE n.chat_id = ${subject.chatId} AND n.user_id = ${subject.userId} AND (n.project_id IS NULL OR NOT p.hidden)
      ORDER BY n.project_id NULLS FIRST, n.created_at, n.id`,
    sql<OwnProject[]>`
      SELECT p.id, p.name, p.tagline, p.status, p.stack, p.links->>'repo' AS repo, p.links->>'site' AS site,
             coalesce((SELECT array_agg(other.user_id ORDER BY other.user_id) FROM project_members other
                       WHERE other.project_id = p.id AND other.user_id <> ${subject.userId}), '{}') AS coauthor_ids
      FROM projects p JOIN project_members pm ON pm.project_id = p.id
      WHERE p.chat_id = ${subject.chatId} AND pm.user_id = ${subject.userId} AND NOT p.hidden ORDER BY p.name, p.id`,
  ]);
  const zone = member?.time_zone && member.time_zone_source ? { zone: member.time_zone, source: member.time_zone_source } : null;
  return { facts, aliases, tagline: member?.tagline ?? null, optedOut: member?.opted_out ?? true, memos, projects, zone };
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

/** Whether a word is in `text`, in some spelling or inflection. */
function wordMatcher(text: string): (word: string) => boolean {
  const said = wordsOf(foldMixedScript(text)).flatMap(variants);
  const forms = new Set(said);
  // An inflected Russian word counts when it differs from the value's word only in its ending: «Варшаве» for «Варшава»,
  // «Берлине» for «Берлин».
  const inflected = (word: string) =>
    said.some(
      (form) =>
        (word.length >= 5 && form.length >= 5 && form.slice(0, -2) === word.slice(0, -2) && Math.abs(form.length - word.length) <= 2) ||
        (word.length >= 3 && form.startsWith(word) && form.length - word.length <= 2),
    );
  return (word) => variants(word).some((form) => forms.has(form)) || inflected(word);
}

/** Whether every word of `value` is in the sender's own words, in some spelling or inflection. */
export function groundedIn(value: string, senderText: string): boolean {
  return wordsOf(foldMixedScript(value)).every(wordMatcher(senderText));
}

/** The share of a worded note's own words that must come from what it was worded from. */
const DRAWN_SHARE = 2 / 3;
const NEGATIONS = new Set(["не", "ни", "нет", "без", "not", "no", "never", "without", "dont", "don't", "isn't", "won't", "can't"]);

/** The words of a text, each with whether a negation stands right before it («не делаем»). */
function wordsWithNegation(text: string): { word: string; negated: boolean }[] {
  const words = text.normalize("NFKC").toLowerCase().replace(/ё/g, "е").match(/[\p{L}\p{N}']+/gu) ?? [];
  return words.map((word, index) => ({ word: word.replace(/'/g, ""), negated: index > 0 && NEGATIONS.has(words[index - 1]!) }));
}

/**
 * Whether a text the bot worded is drawn from `source`: two thirds of its words (short Cyrillic ones aside) are there,
 * in some spelling or form («темы» for «тем»), every number in it is there as it is, and no word is negated in one and not in the
 * other («релиз не раньше марта» never becomes «релиз раньше марта»). A text with nothing of the source in it is made up.
 */
export function drawnFrom(value: string, source: string): boolean {
  const folded = foldMixedScript(value);
  const words = wordsOf(folded).filter((word) => word.length >= 4 || /[a-z0-9]/.test(word));
  if (words.length === 0) return false;
  const inSource = wordMatcher(source);
  const said = wordsWithNegation(foldMixedScript(source));
  if (words.filter((word) => inSource(word) || said.some((use) => sameStem(word, use.word))).length / words.length < DRAWN_SHARE) return false;
  const sourceNumbers = new Set(source.match(/\d+(?:[.,]\d+)?/g) ?? []);
  if ((folded.match(/\d+(?:[.,]\d+)?/g) ?? []).some((number) => !sourceNumbers.has(number))) return false;
  return wordsWithNegation(folded).every(({ word, negated }) => {
    if (NEGATIONS.has(word) || word.length < 3) return true;
    const uses = said.filter((use) => sameStem(word, use.word));
    return uses.length === 0 || uses.some((use) => use.negated === negated);
  });
}

/**
 * Whether `value` is copied from `source`: a run of the source's own words, in their order and in some form («удалить»
 * for «удали»), with nothing left out of its middle but words `spare` lets go (the words that say when, say), and with
 * no negation lost or added: a word has a negation among the two words before it in both or in neither («не ставь», «не
 * надо ставить» never become «ставь»). What someone asks to be done is copied from their words, never reworded.
 */
export function copiedFrom(value: string, source: string, spare: (word: string) => boolean = () => false): boolean {
  const words = wordsWithNegation(foldMixedScript(value)).map(({ word }) => word);
  const said = wordsWithNegation(foldMixedScript(source)).map(({ word }) => word);
  const negatedAt = (text: string[], index: number) => text.slice(Math.max(0, index - 2), index).some((word) => NEGATIONS.has(word));
  const same = (index: number, at: number) => sameStem(words[index]!, said[at]!) && negatedAt(words, index) === negatedAt(said, at);
  if (words.length === 0) return false;
  return said.some((_, start) => {
    let index = 0;
    for (let at = start; at < said.length && index < words.length; at += 1) {
      if (same(index, at)) index += 1;
      else if (index === 0 || !spare(said[at]!)) return false;
    }
    return index === words.length;
  });
}

/** Two forms of one word: the same, or differing only in a short ending («делаем», «делаете»). */
function sameStem(one: string, other: string): boolean {
  if (one === other) return true;
  if (one.length >= 5 && other.length >= 5 && one.slice(0, -2) === other.slice(0, -2)) return true;
  const [short, long] = one.length <= other.length ? [one, other] : [other, one];
  return short.length >= 3 && long.startsWith(short) && long.length - short.length <= 2;
}

/** Other members as names a value must not hold: their names, aliases and @usernames. */
export async function otherMembers(sql: Sql, subject: Subject): Promise<Named[]> {
  return othersOf(sql, subject.chatId, subject.userId);
}

/** Every member of the chat but one, as names. */
export async function othersOf(sql: Sql, chatId: number, userId: number): Promise<Named[]> {
  const people = await sql<{ id: number; display_name: string; username: string | null; aliases: string[] }[]>`
    SELECT u.id, u.display_name, u.username, coalesce(array_agg(a.alias) FILTER (WHERE a.alias IS NOT NULL), '{}') AS aliases
    FROM members m JOIN users u ON u.id = m.user_id
    LEFT JOIN aliases a ON a.chat_id = m.chat_id AND a.user_id = u.id
    WHERE m.chat_id = ${chatId} AND u.id <> ${userId}
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

/** Whether a card value names another member; a link is judged by its path, its own host never counts as a name. */
export function valueNamesSomeone(value: string, others: Named[]): boolean {
  return namesSomeoneElse(cleanText(value).replace(/^https?:\/\/[^/]+\//i, ""), others);
}

export type ValueProblem = "too_long" | "personal_data" | "forbidden" | "names_someone" | "not_their_words" | "bad_link";

/** Where a value goes: a field of the card, its tagline, a name they go by, or a project's tagline or one of its technologies. */
export type CheckedField = OwnField | "tagline" | "alias" | "project_tagline" | "project_stack";

const MAX_VALUE_CHARS = 120;
const MAX_VALUE_WORDS = 12;
const MAX_CHARS: Partial<Record<CheckedField, number>> = { tagline: 90, alias: 40, project_tagline: MAX_PROJECT_TAGLINE_CHARS, project_stack: MAX_STACK_ITEM_CHARS };
/** A project's tagline is a sentence about what it does, longer than a value on a card. */
const MAX_WORDS: Partial<Record<CheckedField, number>> = { project_tagline: 30 };

/** What is wrong with a value a member asked for, if anything: the same limits as a manual edit and then some. */
export function valueProblem(value: string, senderText: string, others: Named[], field: CheckedField): ValueProblem | null {
  const clean = cleanText(value);
  if (!clean || clean.length > (MAX_CHARS[field] ?? MAX_VALUE_CHARS) || wordsOf(clean).length > (MAX_WORDS[field] ?? MAX_VALUE_WORDS)) return "too_long";
  if (maskPersonalData(clean) !== clean) return "personal_data";
  if (hasForbiddenTopic(clean)) return "forbidden";
  if (valueNamesSomeone(clean, others)) return "names_someone";
  if (field === "link") {
    const url = safeHttpUrl(clean.startsWith("http") ? clean : `https://${clean}`);
    const bare = (text: string) => text.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
    return !url ? "bad_link" : bare(senderText).includes(bare(clean)) ? null : "not_their_words";
  }
  if (!groundedIn(clean, senderText)) return "not_their_words";
  return null;
}

/**
 * The words that say a project's status, in either language. A status set from the chat must be one the sender's own
 * words name, whichever of the codes a model picked.
 */
const STATUS_WORDS: Record<ProjectStatus, RegExp> = {
  idea: /(?<!\p{L})(?:иде(?:я|и|ю|ей|е)(?!\p{L})|задумк|концепт)|\b(?:idea|concept)\b/iu,
  in_progress:
    /(?<!\p{L})(?:в работе|в разработке|в процессе|пил(?:ю|им|ит|ят|ишь)(?!\p{L})|допилива|делаю|делаем|разрабатыва|продолжа|возобнов|работаю над|работаем над)|\b(?:in[ _]progress|working on|wip|in development|building|resumed?)\b/iu,
  launched:
    /(?<!\p{L})(?:запущ|запуст|вышел|вышла|вышло|вышли|релиз|зарелиз|выпущ|выпусти|выкат|в проде|на проде|в продакшен|в продакшн|задеплои)|\b(?:launch\w*|release[ds]?|shipped|live|published)\b/iu,
  paused: /(?<!\p{L})(?:пауз|заморо|отложи|отложе|приостанов)|\b(?:paused?|on hold)\b/iu,
  abandoned: /(?<!\p{L})(?:заброш|забросил|бросил|брошен|закрыл|закрыт|мертв|похоронил|забил на)|\b(?:abandon\w*|dropped|dead|killed|gave up|shut down)\b/iu,
};

/** Whether the sender's own words name this status of a project. */
export function statusSaid(status: ProjectStatus, senderText: string): boolean {
  return STATUS_WORDS[status].test(cleanText(senderText).toLowerCase().replace(/ё/g, "е"));
}

/** Every status of a project the words name. */
export function statusesSaid(senderText: string): ProjectStatus[] {
  return PROJECT_STATUSES.filter((status) => statusSaid(status, senderText));
}

export type MemoProblem = "too_long" | "personal_data" | "forbidden" | "names_someone" | "not_their_words";

/**
 * What is wrong with a note, if anything: the limits of a card, and no other member in it, so nobody writes about
 * someone else in a note of their own. From the chat, the note is the sender's newest message as it is, or the bot's
 * wording of their words or of the message they point at, drawn from it.
 */
export function memoProblem(text: string, others: Named[], from?: { said: string; sources: (string | undefined)[] }): MemoProblem | null {
  const clean = cleanText(text);
  if (!clean || clean.length > MAX_MEMO_CHARS) return "too_long";
  if (maskPersonalData(clean) !== clean) return "personal_data";
  if (hasForbiddenTopic(clean)) return "forbidden";
  if (namesSomeoneElse(clean, others)) return "names_someone";
  if (!from) return null;
  const flat = (value: string) => cleanText(value).toLowerCase();
  if (!flat(from.said).includes(flat(clean)) && !from.sources.some((source) => source && drawnFrom(clean, source))) return "not_their_words";
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
  | { kind: "alias_removed"; row: AliasRow }
  | { kind: "memo_added"; memoId: number; projectId: number | null; projectName: string | null; text: string }
  | { kind: "memo_removed"; row: MemoRow; projectName: string | null }
  | { kind: "zone"; before: ZoneState; value: string | null; place: string | null }
  /** The slots of a project the request changed, each as it was and as the request left it. */
  | { kind: "project"; projectId: number; projectName: string; before: Partial<ProjectSlots>; after: Partial<ProjectSlots> };

interface ZoneState {
  time_zone: string | null;
  time_zone_source: ChosenSource | null;
  time_zone_set_at: Date | null;
}

interface MemoRow {
  id: number;
  chat_id: number;
  user_id: number;
  project_id: number | null;
  text: string;
  source_msg_id: number | null;
  created_at: Date;
}

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
  zones?: string[] | null;
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

async function addFact(tx: Queryable, subject: Subject, kind: FactKind, raw: string, msgId: number, zones?: string[]): Promise<Applied[]> {
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
    const placed = kind === "timezone" && zones ? zones : null;
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO facts (chat_id, user_id, kind, value, value_norm, confidence, status, source_msg_ids, zones)
      VALUES (${subject.chatId}, ${subject.userId}, ${kind}, ${value}, ${norm}, 1, 'manual', ${[msgId]}, ${placed})
      ON CONFLICT (chat_id, user_id, kind, value_norm) DO UPDATE SET status = 'manual', value = excluded.value, confidence = 1, updated_at = now(),
        zones = coalesce(excluded.zones, facts.zones)
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
    RETURNING id, chat_id, user_id, kind, value, value_norm, confidence, status, source_msg_ids, zones`;
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

/** Sets the subject's own time zone, or clears it with null; nothing when it is that already. */
async function setOwnZone(tx: Queryable, subject: Subject, zone: string | null, place: string | null, msgId: number): Promise<Applied[]> {
  const [before] = await tx<ZoneState[]>`
    SELECT time_zone, time_zone_source, time_zone_set_at FROM members WHERE chat_id = ${subject.chatId} AND user_id = ${subject.userId}`;
  if (!before || (before.time_zone === zone && (zone === null || before.time_zone_source === "chat"))) return [];
  await tx`
    UPDATE members SET time_zone = ${zone}, time_zone_source = ${zone === null ? null : "chat"}, time_zone_set_at = now()
    WHERE chat_id = ${subject.chatId} AND user_id = ${subject.userId}`;
  await log(tx, subject, "user", subject.userId, "set_time_zone", { zone: before.time_zone, source: before.time_zone_source }, { zone, source: zone === null ? null : "chat", chat_id: subject.chatId }, msgId);
  return [{ kind: "zone", before, value: zone, place }];
}

async function addOwnMemo(tx: Queryable, subject: Subject, op: Extract<OwnOp, { action: "add_memo" }>, msgId: number): Promise<Applied[]> {
  const text = cleanText(op.text);
  const [row] = await tx<{ id: number }[]>`
    INSERT INTO memos (chat_id, user_id, project_id, text, source_msg_id) VALUES (${subject.chatId}, ${subject.userId}, ${op.projectId}, ${text}, ${msgId})
    RETURNING id`;
  await log(tx, subject, "memo", row!.id, "add", null, { text, project_id: op.projectId }, msgId);
  return [{ kind: "memo_added", memoId: row!.id, projectId: op.projectId, projectName: op.projectName, text }];
}

async function removeOwnMemo(tx: Queryable, subject: Subject, op: Extract<OwnOp, { action: "remove_memo" }>, msgId: number): Promise<Applied[]> {
  const [row] = await tx<MemoRow[]>`
    DELETE FROM memos WHERE id = ${op.memoId} AND chat_id = ${subject.chatId} AND user_id = ${subject.userId}
    RETURNING id, chat_id, user_id, project_id, text, source_msg_id, created_at`;
  if (!row) return [];
  await log(tx, subject, "memo", row.id, "remove", { text: row.text, project_id: row.project_id }, null, msgId);
  return [{ kind: "memo_removed", row, projectName: op.projectName }];
}

/** A stack with these technologies taken off and these put on, each once, however they are written. */
export function stackWith(stack: string[], add: string[], remove: string[]): string[] {
  const gone = new Set(remove.map(normalizeValue));
  const result = stack.filter((item) => !gone.has(normalizeValue(item)));
  for (const item of add) {
    if (!result.some((kept) => normalizeValue(kept) === normalizeValue(item))) result.push(item);
  }
  return result;
}

/** The technologies of `stack` that `other` lacks. */
const missingFrom = (stack: string[], other: string[]) => stack.filter((item) => !other.some((kept) => normalizeValue(kept) === normalizeValue(item)));

/** What a stack gained and lost from one version to the next. */
export function stackChanges(before: string[], after: string[]): { added: string[]; removed: string[] } {
  return { added: missingFrom(after, before), removed: missingFrom(before, after) };
}

/** The slots a request's change would change on a project as it is now, each as it is and as it would be. */
export function plannedSlots(current: ProjectSlots, change: ProjectChange): { before: Partial<ProjectSlots>; after: Partial<ProjectSlots> } {
  const before: Partial<ProjectSlots> = {};
  const after: Partial<ProjectSlots> = {};
  if (change.tagline !== undefined && change.tagline !== current.tagline) {
    before.tagline = current.tagline;
    after.tagline = change.tagline;
  }
  if (change.status !== undefined && change.status !== current.status) {
    before.status = current.status;
    after.status = change.status;
  }
  const stack = stackWith(current.stack, change.stackAdd ?? [], change.stackRemove ?? []);
  if (stack.join("\n") !== current.stack.join("\n")) {
    before.stack = current.stack;
    after.stack = stack;
  }
  for (const slot of ["repo", "site"] as const) {
    const value = change[slot];
    if (value === undefined || value === current[slot]) continue;
    before[slot] = current[slot];
    after[slot] = value;
  }
  return { before, after };
}

/**
 * A request's change as the fields of a project edit, made on the project as it is once locked; a slot its `from`
 * names changes only while it holds that value.
 */
function projectFields(current: EditableValues, change: ProjectChange): ProjectFields {
  const holds = (slot: keyof NonNullable<ProjectChange["from"]>, value: string | null) => change.from?.[slot] === undefined || change.from[slot] === value;
  const stacked = Boolean(change.stackAdd?.length || change.stackRemove?.length);
  const repo = change.repo !== undefined && holds("repo", current.links.repo ?? null) ? change.repo : undefined;
  const site = change.site !== undefined && holds("site", current.links.site ?? null) ? change.site : undefined;
  return {
    tagline: change.tagline !== undefined && holds("tagline", current.tagline) ? change.tagline : undefined,
    status: change.status !== undefined && holds("status", current.status) ? change.status : undefined,
    stack: stacked ? stackWith(current.stack, change.stackAdd ?? [], change.stackRemove ?? []) : undefined,
    links: repo !== undefined || site !== undefined ? { repo, site } : undefined,
  };
}

/** The slots an edit changed, each as it was and as it is now; a link counts on its own. */
function changedSlots(edit: ProjectEdit): { before: Partial<ProjectSlots>; after: Partial<ProjectSlots> } {
  const before: Partial<ProjectSlots> = {};
  const after: Partial<ProjectSlots> = {};
  if (edit.fields.includes("tagline")) {
    before.tagline = edit.before.tagline ?? null;
    after.tagline = edit.after.tagline ?? null;
  }
  if (edit.fields.includes("status") && edit.before.status && edit.after.status) {
    before.status = edit.before.status;
    after.status = edit.after.status;
  }
  if (edit.fields.includes("stack")) {
    before.stack = edit.before.stack ?? [];
    after.stack = edit.after.stack ?? [];
  }
  for (const slot of ["repo", "site"] as const) {
    const was = edit.before.links?.[slot] ?? null;
    const now = edit.after.links?.[slot] ?? null;
    if (!edit.fields.includes("links") || was === now) continue;
    before[slot] = was;
    after[slot] = now;
  }
  return { before, after };
}

/** A project's entry changed by one of its authors: the Mini App's own edit, which row-level security keeps to their projects. */
async function editOwnProject(tx: Queryable, subject: Subject, op: Extract<OwnOp, { action: "edit_project" }>, msgId: number): Promise<Applied[]> {
  const edit = await editProject(tx, { chatId: subject.chatId, projectId: op.projectId }, (current) => projectFields(current, op.change), {
    source: "user",
    actorUserId: subject.userId,
    sourceMsgIds: [msgId],
  });
  if (!edit) return [];
  const { before, after } = changedSlots(edit);
  return Object.keys(after).length ? [{ kind: "project", projectId: op.projectId, projectName: op.projectName, before, after }] : [];
}

type ProjectApplied = Extract<Applied, { kind: "project" }>;

/**
 * What an Undo of a request's change sets on a project as it is now: a slot goes back only while it still holds what
 * the request left there, so a later edit in the chat or the Mini App stays; each technology it added comes off and
 * each it took off comes back on its own.
 */
function undoFields(current: EditableValues, change: ProjectApplied): ProjectFields {
  const { before, after } = change;
  const fields: ProjectFields = {};
  if (after.tagline !== undefined && current.tagline === after.tagline) fields.tagline = before.tagline ?? null;
  if (after.status !== undefined && before.status !== undefined && current.status === after.status) fields.status = before.status;
  if (after.stack && before.stack) fields.stack = stackWith(current.stack, missingFrom(before.stack, after.stack), missingFrom(after.stack, before.stack));
  const links: NonNullable<ProjectFields["links"]> = {};
  for (const slot of ["repo", "site"] as const) {
    if (after[slot] !== undefined && (current.links[slot] ?? null) === after[slot]) links[slot] = before[slot] ?? null;
  }
  if (Object.keys(links).length) fields.links = links;
  return fields;
}

/**
 * The change a Redo brings back after an Undo: what the Undo took back (`undone`, each slot as the Undo left it and as
 * it found it), each slot only while it still holds what the Undo put there.
 */
function redoOf(undone: ProjectApplied): ProjectChange {
  const { before, after } = undone;
  const change: ProjectChange = {};
  const from: NonNullable<ProjectChange["from"]> = {};
  if (typeof after.tagline === "string") {
    change.tagline = after.tagline;
    from.tagline = before.tagline ?? null;
  }
  if (after.status && before.status) {
    change.status = after.status;
    from.status = before.status;
  }
  if (after.stack && before.stack) {
    const { added, removed } = stackChanges(before.stack, after.stack);
    change.stackAdd = added;
    change.stackRemove = removed;
  }
  for (const slot of ["repo", "site"] as const) {
    if (after[slot] === undefined) continue;
    change[slot] = after[slot];
    from[slot] = before[slot] ?? null;
  }
  return { ...change, from };
}

/**
 * Puts back what a request changed on a project, the project's own edit logged as an Undo of it, so its history tells
 * the change that was taken back. What the request locked against the chronicler stays locked. Gives what it took back,
 * as the request's change (each slot as the Undo left it and as it found it), with the change a Redo brings back;
 * nothing when it could put nothing back, everything having changed since.
 */
async function undoProjectEdit(tx: Queryable, subject: Subject, change: ProjectApplied, msgId: number): Promise<{ undone: ProjectApplied; redo: ProjectChange } | null> {
  const edit = await editProject(
    tx,
    { chatId: subject.chatId, projectId: change.projectId },
    (current) => undoFields(current, change),
    { source: "user", actorUserId: subject.userId, sourceMsgIds: [msgId] },
    { undo: true },
  );
  if (!edit) return null;
  // The Undo's edit goes from what the request left to what was there before it: the change taken back is that, reversed.
  const reverted = changedSlots(edit);
  if (Object.keys(reverted.after).length === 0) return null;
  const undone: ProjectApplied = { kind: "project", projectId: change.projectId, projectName: change.projectName, before: reverted.after, after: reverted.before };
  return { undone, redo: redoOf(undone) };
}

/**
 * Applies the operations to the subject's own card, all or nothing, and records them on the request in the same
 * transaction, so a receipt that fails to go out never leaves a change nobody can undo. Someone who opted out gets
 * nothing added. `fromStatus` is what the request must still be (a tap on an old preview finds it changed). `asPlan`
 * makes these operations the request's plan in the same transaction, for a plan a tap completed (a project picked).
 */
export async function applyOwnOps(sql: Sql, subject: Subject, ops: OwnOp[], msgId: number, requestId: number, fromStatus: string, asPlan = false): Promise<Applied[] | null> {
  return asSubject(sql, subject, async (tx) => {
    const [request] = await tx`SELECT 1 FROM self_edits WHERE id = ${requestId} AND status = ${fromStatus} FOR UPDATE`;
    if (!request) return null;
    const [member] = await tx<{ opted_out: boolean }[]>`SELECT opted_out FROM members WHERE chat_id = ${subject.chatId} AND user_id = ${subject.userId} FOR UPDATE`;
    const adds = new Set(["add", "replace", "set_tagline", "add_alias", "add_memo", "set_zone"]);
    const applied: Applied[] = [];
    const memoCount = async (projectId: number | null) =>
      (await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM memos WHERE chat_id = ${subject.chatId} AND user_id = ${subject.userId} AND project_id IS NOT DISTINCT FROM ${projectId}`)[0]?.count ?? 0;
    for (const op of ops) {
      if (member?.opted_out !== false && adds.has(op.action)) continue;
      if (op.action === "add_memo" && (await memoCount(op.projectId)) >= MAX_MEMOS) continue;
      if (op.action === "add") applied.push(...(await addFact(tx, subject, op.field, op.value, msgId, op.zones)));
      else if (op.action === "remove") applied.push(...(await removeFact(tx, subject, op.factId, msgId)));
      else if (op.action === "replace") {
        applied.push(...(await removeFact(tx, subject, op.factId, msgId)));
        applied.push(...(await addFact(tx, subject, op.field, op.value, msgId, op.zones)));
      } else if (op.action === "set_tagline") applied.push(...(await setTaglineOf(tx, subject, cleanText(op.value), msgId)));
      else if (op.action === "clear_tagline") applied.push(...(await setTaglineOf(tx, subject, null, msgId)));
      else if (op.action === "add_alias") applied.push(...(await addOwnAlias(tx, subject, op.value, msgId)));
      else if (op.action === "remove_alias") applied.push(...(await removeOwnAlias(tx, subject, op.aliasId, msgId)));
      else if (op.action === "add_memo") applied.push(...(await addOwnMemo(tx, subject, op, msgId)));
      else if (op.action === "set_zone") applied.push(...(await setOwnZone(tx, subject, op.zone, op.place, msgId)));
      else if (op.action === "clear_zone") applied.push(...(await setOwnZone(tx, subject, null, null, msgId)));
      else if (op.action === "edit_project") applied.push(...(await editOwnProject(tx, subject, op, msgId)));
      else applied.push(...(await removeOwnMemo(tx, subject, op, msgId)));
    }
    if (applied.length === 0) return applied;
    await tx`
      UPDATE self_edits SET status = 'applied', applied = ${tx.json(applied as never)}, decided_at = now()${asPlan ? tx`, plan = ${tx.json(ops as never)}` : tx``}
      WHERE id = ${requestId}`;
    return applied;
  });
}

/**
 * Undoes what applyOwnOps recorded on the request, newest first, on the subject's own card and projects only, and gives
 * what it took back: on a project, only the slots nobody changed since. The request's plan becomes what a Redo brings
 * back, on a project only while nothing changed it since the Undo. Null when there is nothing to undo; empty, with the
 * request left as it was, when everything it changed was changed since.
 */
export async function undoOwnOps(sql: Sql, subject: Subject, requestId: number, msgId: number): Promise<Applied[] | null> {
  return asSubject(sql, subject, async (tx) => {
    const [request] = await tx<{ applied: Applied[] | null; plan: OwnOp[] | null }[]>`
      SELECT applied, plan FROM self_edits
      WHERE id = ${requestId} AND status = 'applied' AND applied IS NOT NULL AND created_at > now() - interval '24 hours'
      FOR UPDATE`;
    if (!request?.applied) return null;
    const [member] = await tx<{ opted_out: boolean }[]>`SELECT opted_out FROM members WHERE chat_id = ${subject.chatId} AND user_id = ${subject.userId}`;
    // Nothing comes back onto the card of someone who has opted out since.
    const restores = new Set(["fact_removed", "alias_removed", "tagline", "memo_removed", "zone"]);
    const undone: Applied[] = [];
    /** What a Redo brings back to each project, the Undo having taken it back. */
    const redo = new Map<number, ProjectChange>();
    for (const change of [...request.applied].reverse()) {
      if (change.kind === "project") {
        const taken = await undoProjectEdit(tx, subject, change, msgId);
        if (taken) {
          undone.unshift(taken.undone);
          redo.set(change.projectId, taken.redo);
        }
        continue;
      }
      undone.unshift(change);
      if (member?.opted_out !== false && restores.has(change.kind)) continue;
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
          INSERT INTO facts (id, chat_id, user_id, kind, value, value_norm, confidence, status, source_msg_ids, zones)
          VALUES (${row.id}, ${subject.chatId}, ${subject.userId}, ${row.kind}, ${row.value}, ${row.value_norm}, ${row.confidence}, ${row.status}, ${row.source_msg_ids}, ${row.zones ?? null})
          ON CONFLICT DO NOTHING`;
        await tx`DELETE FROM rejected_facts WHERE chat_id = ${subject.chatId} AND user_id = ${subject.userId} AND kind = ${row.kind} AND value_norm = ${row.value_norm}`;
      } else if (change.kind === "tagline") {
        await tx`
          UPDATE members SET tagline = ${change.before.tagline}, tagline_manual = ${change.before.tagline_manual}
          WHERE chat_id = ${subject.chatId} AND user_id = ${subject.userId}`;
      } else if (change.kind === "zone") {
        // Only the zone this change set goes back: one chosen since in the Mini App or taken from a device stays.
        await tx`
          UPDATE members SET time_zone = ${change.before.time_zone}, time_zone_source = ${change.before.time_zone_source}, time_zone_set_at = ${change.before.time_zone_set_at}
          WHERE chat_id = ${subject.chatId} AND user_id = ${subject.userId} AND time_zone IS NOT DISTINCT FROM ${change.value}
            AND time_zone_source IS NOT DISTINCT FROM ${change.value === null ? null : "chat"}`;
      } else if (change.kind === "memo_added") {
        await tx`DELETE FROM memos WHERE id = ${change.memoId} AND chat_id = ${subject.chatId} AND user_id = ${subject.userId}`;
      } else if (change.kind === "memo_removed") {
        // A note comes back only while its project is there to take it.
        const row = change.row;
        const [kept] = await tx<{ count: number }[]>`
          SELECT count(*)::int AS count FROM memos WHERE chat_id = ${subject.chatId} AND user_id = ${subject.userId} AND project_id IS NOT DISTINCT FROM ${row.project_id}`;
        if ((kept?.count ?? 0) >= MAX_MEMOS) continue;
        await tx`
          INSERT INTO memos (id, chat_id, user_id, project_id, text, source_msg_id, created_at)
          SELECT ${row.id}, ${subject.chatId}, ${subject.userId}, ${row.project_id}, ${row.text}, ${row.source_msg_id}, ${row.created_at}
          WHERE ${row.project_id}::int IS NULL OR EXISTS (SELECT 1 FROM projects WHERE id = ${row.project_id}::int AND NOT hidden)
          ON CONFLICT DO NOTHING`;
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
    if (undone.length === 0) return undone;
    const plan = (request.plan ?? []).flatMap((op): OwnOp[] => {
      if (op.action !== "edit_project") return [op];
      const change = redo.get(op.projectId);
      return change ? [{ ...op, change }] : [];
    });
    await tx`UPDATE self_edits SET status = 'undone', decided_at = now(), plan = ${tx.json(plan as never)} WHERE id = ${requestId}`;
    await log(tx, subject, "self_edit", msgId, "undo", null, null, msgId);
    return undone;
  });
}

/** Whether the chronicler may give a person this alias: not one they took off themselves. */
export async function aliasRejected(sql: Queryable, chatId: number, userId: number, alias: string): Promise<boolean> {
  const [row] = await sql`SELECT 1 FROM rejected_facts WHERE chat_id = ${chatId} AND user_id = ${userId} AND kind = ${ALIAS_STOP} AND value_norm = ${aliasNorm(alias)}`;
  return Boolean(row);
}
