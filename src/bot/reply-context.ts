import type { Message, User as TelegramUser, UserFromGetMe } from "grammy/types";
import { ambiguousNames, chatAliases, nameForms, namedIn, type Named, type NamedAlias } from "../core/aliases.js";
import type { Sql } from "../core/db.js";
import { FACT_KINDS, MIN_VISIBLE_CONFIDENCE } from "../core/facts.js";
import { maskPersonalData } from "../core/privacy.js";
import {
  ABANDONED_MULTIPLIER,
  formerNames,
  listProjects,
  ratingBreakdown,
  STATUS_LABELS,
  type FormerName,
  type ProjectListItem,
  type RatingBreakdown,
} from "../core/projects.js";
import { slugify, transliterateName, truncate } from "../core/text.js";
import { peopleOfChat, SERVICE_TG_IDS, type Person } from "../core/users.js";
import { skippedMessageIds } from "../worker/extract.js";
import { realReply } from "./kit.js";

/**
 * The data part of an answer's prompt: who the bot is, the members and the names they go by, the catalog and the
 * chronicle, fuller cards of the people the question is about, the conversation it belongs to and the latest messages.
 * Everything is read from the database; texts go through maskPersonalData.
 */

export interface Question {
  chatId: number;
  chatTitle: string | null;
  message: Message;
  from: TelegramUser;
  /** The bot itself (ctx.me). */
  me: UserFromGetMe;
}

export interface RecentAnswer {
  to: string;
  text: string;
  /** The message the answer was posted as, when it is known. */
  msgId?: number;
}

export interface ReplyContextOptions {
  timezone: string;
  /** The model writing this answer: the bot can say which one it is. */
  model: string;
  ownerTgIds: number[];
  recentAnswers?: RecentAnswer[];
  /** The motif for a comeback, should the question be an insult. */
  insultMotif: string;
}

const CONTEXT_MESSAGES = 30;
const CHRONICLE_DAYS = 30;
const CHRONICLE_ENTRIES = 40;
/** Caps that keep a big chat's prompt well under 100K tokens, where Haiku's price goes up fivefold. */
const MAX_MEMBERS = 150;
const MAX_FACTS_PER_MEMBER = 12;
const MAX_PROJECTS = 60;
const MESSAGE_CHARS = 500;
const THREAD_HOPS = 12;
const THREAD_CHARS = 400;
/** A conversation to referee runs back to the last pause this long, and is quoted in shorter lines. */
const SEGMENT_PAUSE_MS = 25 * 60_000;
const SEGMENT_MESSAGES = 120;
const SEGMENT_CHARS = 250;
const FOCUS_PEOPLE = 5;
/** About 400 tokens a person. */
const FOCUS_CHARS = 1400;
const FOCUS_EXCHANGES = 3;
const FOCUS_TOPICS = 5;
const FOCUS_TOPIC_DAYS = 60;
const DETAIL_PROJECTS = 3;
const DETAIL_SIGNALS_PER_KIND = 4;
const AMBIGUOUS_NAMES = 10;

/** Text from members can't open or close a section of the prompt. */
function safe(text: string): string {
  return text.replace(/</g, "‹").replace(/>/g, "›");
}

function line(text: string, max: number): string {
  return safe(truncate(maskPersonalData(text.replace(/\s+/g, " ").trim()), max));
}

/** A text without the bot's @username, which would otherwise read as a mention of a project named like the bot. */
function withoutMention(text: string, me: UserFromGetMe): string {
  return text.replace(new RegExp(`@${me.username}\\b`, "gi"), "").replace(/\s+/g, " ").trim();
}

/** The question without the bot's @username. */
export function questionText(message: Message, me: UserFromGetMe): string {
  return withoutMention(message.text ?? message.caption ?? "", me);
}

const REFEREE = /рассуди(?:те)?(?!\p{L})|кто\s+(?:\S+\s+){0,2}прав(?:а|ы)?(?!\p{L})|кто из нас|о ч[её]м (?:\S+ )?спор|что за спор|разреши(?:те)? (?:\S+ )?спор|кто выиграл|who(?:'s| is) right|settle (?:this|it)|what are (?:they|you|we) arguing about/iu;

/** «Рассуди», «кто прав», «о чём спор», "settle this": the member wants the bot to referee the conversation under way. */
export function asksToReferee(text: string): boolean {
  return REFEREE.test(text);
}

const RATING_WORDS = /(?<!\p{L})(?:рейтинг|балл|очк|голос|топ(?:е|а|у|ом)?(?!\p{L})|rating|score|points?(?!\p{L})|vot(?:e|es|ed|ing)(?!\p{L}))/iu;

export function asksAboutRating(text: string): boolean {
  return RATING_WORDS.test(text);
}

interface Clock {
  timezone: string;
  /** YYYY-MM-DD in the display timezone. */
  today: string;
}

const dayOf = (date: Date, timeZone: string) => date.toLocaleDateString("en-CA", { timeZone });

/** «8 Nov», or «8 Nov 2025» in another year. */
function dateLabel(date: Date, clock: Clock): string {
  const sameYear = dayOf(date, clock.timezone).slice(0, 4) === clock.today.slice(0, 4);
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }), timeZone: clock.timezone });
}

/** «14:05» today, «8 Nov 14:05» on another day. */
function timeLabel(date: Date, clock: Clock): string {
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: clock.timezone });
  return dayOf(date, clock.timezone) === clock.today ? time : `${dateLabel(date, clock)} ${time}`;
}

interface ContextMessage {
  msg_id: number;
  sent_at: Date;
  text: string;
  media_type: string | null;
  reply_to_bot: boolean;
  reply_to_msg_id: number | null;
  from_bot: boolean;
  user_id: number | null;
  display_name: string | null;
}

function messageLine(row: ContextMessage, clock: Clock, max: number): string {
  const author = row.from_bot ? "Waggle" : safe(row.display_name ?? "someone");
  const reply = row.reply_to_bot ? " ↩Waggle" : row.reply_to_msg_id ? ` ↩${row.reply_to_msg_id}` : "";
  const media = row.media_type ? ` [${row.media_type}]` : "";
  const text = line(row.text, max);
  return `[${row.msg_id} ${timeLabel(row.sent_at, clock)}] ${author}${reply}${media}${text ? `: ${text}` : ""}`;
}

/** The run of messages before the question, back to the last pause of SEGMENT_PAUSE_MS between two of them. */
function currentSegment(newestFirst: ContextMessage[]): ContextMessage[] {
  const segment: ContextMessage[] = [];
  for (const row of newestFirst) {
    const later = segment.at(-1);
    if (later && later.sent_at.getTime() - row.sent_at.getTime() >= SEGMENT_PAUSE_MS) break;
    segment.push(row);
  }
  return segment.reverse();
}

const MESSAGE_COLUMNS = "m.msg_id, m.sent_at, m.text, m.media_type, m.reply_to_bot, m.reply_to_msg_id, m.from_bot, m.user_id, u.display_name";

/** The messages the question replies to, up to the root of the conversation, root first; the bot's own included. */
async function replyChain(sql: Sql, chatId: number, parentId: number): Promise<ContextMessage[]> {
  return sql<ContextMessage[]>`
    WITH RECURSIVE chain AS (
      SELECT msg_id, reply_to_msg_id, 1 AS hops FROM messages WHERE chat_id = ${chatId} AND msg_id = ${parentId}
      UNION ALL
      SELECT m.msg_id, m.reply_to_msg_id, chain.hops + 1
      FROM chain JOIN messages m ON m.chat_id = ${chatId} AND m.msg_id = chain.reply_to_msg_id
      WHERE chain.hops < ${THREAD_HOPS} AND m.msg_id < chain.msg_id
    )
    SELECT ${sql.unsafe(MESSAGE_COLUMNS)}
    FROM chain JOIN messages m ON m.chat_id = ${chatId} AND m.msg_id = chain.msg_id LEFT JOIN users u ON u.id = m.user_id
    ORDER BY chain.hops DESC`;
}

function authorOf(replied: NonNullable<Message["reply_to_message"]>, me: UserFromGetMe): string {
  if (replied.from?.id === me.id) return "Waggle";
  if (replied.sender_chat && "title" in replied.sender_chat) return replied.sender_chat.title ?? "a channel";
  return [replied.from?.first_name, replied.from?.last_name].filter(Boolean).join(" ") || "someone";
}

const ALIAS_SOURCE: Record<NamedAlias["source"], { person: string; project: string }> = {
  owner: { person: "owner", project: "owner" },
  person: { person: "self", project: "author" },
  chronicler: { person: "chronicler", project: "chronicler" },
};

function aliasLabel(alias: NamedAlias): string {
  return `${safe(maskPersonalData(alias.alias))} (${ALIAS_SOURCE[alias.source][alias.user_id === null ? "project" : "person"]})`;
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}

/** Adds lines while they fit into `budget` characters; the first one that does not is cut short, and the rest left out. */
function withinBudget(lines: string[], budget: number): string[] {
  const kept: string[] = [];
  let left = budget;
  for (const text of lines) {
    if (left <= 1) break;
    kept.push(text.length <= left ? text : truncate(text, left));
    left -= text.length + 1;
  }
  return kept;
}

const points = (value: number) => value.toFixed(1).replace(/\.0$/, "");

interface FocusFact {
  user_id: number;
  kind: string;
  value: string;
  status: string;
  said_at: Date;
}

interface FocusExchange {
  user_id: number;
  asked: string;
  media_type: string | null;
  answer: string;
  sent_at: Date;
}

interface FocusTopic {
  user_id: number;
  title: string;
  summary: string;
  period_to: Date;
}

type FocusReason = "asking" | "replied to" | "named";

function aboutYouBlock(input: {
  me: UserFromGetMe;
  model: string;
  owners: { id: number; display_name: string; username: string | null }[];
  aliasesOf: Map<number, NamedAlias[]>;
  catalogEntry: { project: ProjectListItem; rank: number; total: number } | undefined;
}): string {
  const { me } = input;
  const owners = input.owners.map((owner) => {
    const aliases = (input.aliasesOf.get(owner.id) ?? []).map((alias) => safe(maskPersonalData(alias.alias)));
    return `${safe(owner.display_name)}${owner.username ? ` (@${owner.username})` : ""}${aliases.length ? `, also called ${aliases.join(", ")}` : ""}`;
  });
  const entry = input.catalogEntry;
  return [
    "<about_you>",
    `You are ${safe(me.first_name)} (@${me.username}), the chat's chronicler bot; this answer is written by ${input.model}.`,
    owners.length ? `Your ${owners.length > 1 ? "owners, who built you and pay" : "owner, who built you and pays"} for you: ${owners.join("; ")}.` : "",
    "You read the chat and keep the members' cards, the project catalog with its rating and the chronicle, and you answer when someone mentions you or replies to you. You cannot change any data, vote, run code, browse the web or send images or widgets. People edit their cards in the Mini App (/app); /forgetme erases what you know about a person.",
    entry
      ? `In the catalog you are the project ${safe(entry.project.name)}: #${entry.rank} of ${entry.total}, ${entry.project.score} rating points, ${entry.project.votes} vote(s).`
      : "",
    "</about_you>",
  ]
    .filter(Boolean)
    .join("\n");
}

function whoIsWhoBlock(input: {
  people: Person[];
  aliasesOf: Map<number, NamedAlias[]>;
  projects: ProjectListItem[];
  projectAliases: Map<number, NamedAlias[]>;
  former: Map<number, FormerName[]>;
  ambiguous: { names: string[]; ids: number[] }[];
}): string {
  const names = new Map(input.people.map((person) => [person.id, person.display_name]));
  const people = input.people.flatMap((person) => {
    const known = [...transliterateName(person.display_name).map(safe), ...(input.aliasesOf.get(person.id) ?? []).map(aliasLabel)];
    return known.length ? [`${safe(person.display_name)}: ${known.join(", ")}`] : [];
  });
  const projects = input.projects.flatMap((project) => {
    const earlier = [...new Set((input.former.get(project.id) ?? []).map((entry) => entry.name).filter((name) => name.toLowerCase() !== project.name.toLowerCase()))];
    const known = [...(input.projectAliases.get(project.id) ?? []).map(aliasLabel), ...earlier.map((name) => `was ${safe(name)}`)];
    return known.length ? [`#${project.slug} ${safe(project.name)}: ${known.join(", ")}`] : [];
  });
  const flags = input.ambiguous
    .slice(0, AMBIGUOUS_NAMES)
    .map((group) => `“${group.names.map(safe).join("” / “")}” may mean ${group.ids.map((id) => safe(names.get(id) ?? "?")).join(" or ")}`);
  if (people.length + projects.length + flags.length === 0) return "";
  return `<who_is_who note="other spellings and names people use; @usernames are in members">\n${[...people, ...projects, ...flags].join("\n")}\n</who_is_who>`;
}

function projectDetailsBlock(input: {
  ranked: ProjectListItem[];
  picked: ProjectListItem[];
  breakdown: Map<number, RatingBreakdown>;
  former: Map<number, FormerName[]>;
  clock: Clock;
}): string {
  const { ranked, clock } = input;
  const [leader, second] = ranked;
  const sections = input.picked.map((project) => {
    const rank = ranked.findIndex((candidate) => candidate.id === project.id) + 1;
    const standing =
      leader?.id === project.id
        ? `leads${second ? `; next is ${safe(second.name)} with ${second.score}` : ""}`
        : leader
          ? `the leader ${safe(leader.name)} has ${leader.score} (${leader.score - project.score} more)`
          : "";
    const { votes, signals } = input.breakdown.get(project.id) ?? { votes: [], signals: [] };
    const counted = groupBy(
      signals.filter((signal) => signal.kind !== "milestone" && signal.points > 0),
      (signal) => signal.kind,
    );
    const kinds = [...counted].map(([kind, list]) => {
      const total = list.reduce((sum, signal) => sum + signal.points, 0);
      const shown = list
        .slice(0, DETAIL_SIGNALS_PER_KIND)
        .map((signal) => `impact ${signal.impact}, ${dateLabel(signal.happened_at, clock)} → ${points(signal.points)}`);
      const more = list.length > DETAIL_SIGNALS_PER_KIND ? `; +${list.length - DETAIL_SIGNALS_PER_KIND} more` : "";
      return `${kind} ${points(total)} (${shown.join("; ")}${more})`;
    });
    const milestones = signals
      .filter((signal) => signal.kind === "milestone")
      .map((signal) => `${dateLabel(signal.happened_at, clock)} “${line(signal.note, 80)}” (${signal.points > 0 ? `counts ${points(signal.points)}` : "counts 0 now"})`);
    const renames = (input.former.get(project.id) ?? [])
      .filter((entry) => !entry.merged)
      .map((entry) => `from ${safe(entry.name)} on ${dateLabel(entry.at, clock)}`);
    return [
      `${safe(project.name)} (#${project.slug}): #${rank} of ${ranked.length}, ${project.score} rating points${standing ? `; ${standing}` : ""}. Status: ${STATUS_LABELS[project.status] ?? project.status}.`,
      `Votes: ${votes.length}${votes.length ? ` (${votes.map((at) => dateLabel(at, clock)).join(", ")})` : ""}.`,
      kinds.length ? `Signals counted now, in points: ${kinds.join("; ")}.` : "No other signals count now.",
      project.status === "abandoned" ? `Abandoned: the total is multiplied by ${ABANDONED_MULTIPLIER}.` : "",
      renames.length ? `Renamed ${renames.join(", ")}.` : "",
      milestones.length ? `Milestones of all time: ${milestones.join("; ")}.` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });
  return sections.length ? `<project_details>\n${sections.join("\n\n")}\n</project_details>` : "";
}

function inFocusBlock(input: {
  focus: { person: Person; reason: FocusReason }[];
  facts: Map<number, FocusFact[]>;
  exchanges: Map<number, FocusExchange[]>;
  topics: Map<number, FocusTopic[]>;
  projects: ProjectListItem[];
  clock: Clock;
}): string {
  const { clock } = input;
  const people = input.focus.map(({ person, reason }) => {
    const header = `- ${safe(person.display_name)}${person.username ? ` (@${person.username})` : ""}, ${reason}`;
    if (person.opted_out) return `${header}: asked not to collect anything about them`;
    const card = [...groupBy(input.facts.get(person.id) ?? [], (fact) => fact.kind)].map(
      ([kind, facts]) =>
        `${kind.replace("_", " ")}: ${facts.map((fact) => `${safe(fact.value)} (${fact.status === "manual" ? "✍ " : ""}${dateLabel(fact.said_at, clock)})`).join(", ")}`,
    );
    const ranked = input.projects.map((project, index) => ({ project, rank: index + 1 }));
    const own = ranked
      .filter(({ project }) => project.authors.some((author) => author.id === person.id))
      .map(({ project, rank }) => `${safe(project.name)} #${rank} (${project.score} pts, ${STATUS_LABELS[project.status] ?? project.status})`);
    const exchanges = (input.exchanges.get(person.id) ?? []).map(
      (exchange) =>
        `${timeLabel(exchange.sent_at, clock)} “${exchange.asked.trim() ? line(exchange.asked, 100) : `[${exchange.media_type ?? "no text"}]`}” → you: “${line(exchange.answer, 140)}”`,
    );
    const topics = (input.topics.get(person.id) ?? []).map((topic) => `${dateLabel(topic.period_to, clock)}: ${line(`${topic.title} — ${topic.summary}`, 140)}`);
    return withinBudget(
      [
        `${header}${person.tagline ? ` — ${safe(person.tagline)}` : ""}`,
        card.length ? `  card: ${card.join("; ")}` : "  card: nothing yet",
        own.length ? `  projects: ${own.join(", ")}` : "",
        exchanges.length ? `  with you lately: ${exchanges.join("; ")}` : "",
        topics.length ? `  in the chronicle: ${topics.join("; ")}` : "",
      ].filter(Boolean),
      FOCUS_CHARS,
    ).join("\n");
  });
  return people.length
    ? `<in_focus note="the people this question is about; dates say when a fact was said, ✍ marks what the person wrote themselves">\n${people.join("\n")}\n</in_focus>`
    : "";
}

/** Everything the app knows about the chat, as the reply prompt's data. */
export async function buildReplyContext(sql: Sql, question: Question, options: ReplyContextOptions): Promise<string> {
  const { chatId, message, me } = question;
  const clock: Clock = { timezone: options.timezone, today: dayOf(new Date(), options.timezone) };
  const asked = questionText(message, me);
  const referee = asksToReferee(asked);
  const replied = realReply(message);
  // Messages the chronicler skipped because the model refused them are kept out here too.
  const skipped = await skippedMessageIds(sql, chatId);
  const [people, facts, projects, chronicle, latest, chain, aliases, former, owners] = await Promise.all([
    peopleOfChat(sql, chatId),
    sql<{ user_id: number; kind: string; value: string }[]>`
      SELECT user_id, kind, value FROM facts
      WHERE chat_id = ${chatId} AND (status = 'manual' OR (status = 'auto' AND confidence >= ${MIN_VISIBLE_CONFIDENCE}))
      ORDER BY user_id, array_position(${[...FACT_KINDS]}::text[], kind), status = 'manual' DESC, confidence DESC, id`,
    listProjects(sql, chatId, { sort: "top" }),
    sql<{ title: string; summary: string; period_to: Date }[]>`
      SELECT title, summary, period_to FROM chronicle
      WHERE chat_id = ${chatId} AND importance >= 2 AND period_to > now() - ${`${CHRONICLE_DAYS} days`}::interval
      ORDER BY period_to DESC LIMIT ${CHRONICLE_ENTRIES}`,
    sql<ContextMessage[]>`
      SELECT ${sql.unsafe(MESSAGE_COLUMNS)}
      FROM messages m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.chat_id = ${chatId} AND m.msg_id < ${message.message_id} AND m.msg_id <> ALL(${skipped}::bigint[])
        AND (btrim(m.text) <> '' OR m.media_type IS NOT NULL)
      ORDER BY m.msg_id DESC LIMIT ${referee ? SEGMENT_MESSAGES : CONTEXT_MESSAGES}`,
    replied ? replyChain(sql, chatId, replied.message_id) : Promise.resolve([]),
    chatAliases(sql, chatId),
    formerNames(sql, chatId),
    options.ownerTgIds.length
      ? sql<{ id: number; display_name: string; username: string | null }[]>`
          SELECT id, display_name, username FROM users WHERE tg_id = ANY(${options.ownerTgIds}::bigint[]) ORDER BY id`
      : Promise.resolve([]),
  ]);

  const inContext = people.slice(0, MAX_MEMBERS);
  const aliasesOf = groupBy(
    aliases.filter((alias) => alias.user_id !== null),
    (alias) => alias.user_id!,
  );
  const projectAliases = groupBy(
    aliases.filter((alias) => alias.project_id !== null),
    (alias) => alias.project_id!,
  );
  const formerOf = groupBy(former, (entry) => entry.project_id);

  const shown = (row: ContextMessage) => Boolean(row.text.trim() || row.media_type) && !skipped.includes(row.msg_id);
  const thread = chain.filter(shown);
  const parentStored = replied ? chain.some((row) => row.msg_id === replied.message_id) : false;
  const conversation = referee ? currentSegment(latest) : [...latest].reverse();

  // The people this question is about: who asks, whose message it answers, and whoever it or its thread names.
  const named: Named[] = inContext.map((person) => ({
    id: person.id,
    username: person.username,
    forms: nameForms(person.display_name, (aliasesOf.get(person.id) ?? []).map((alias) => alias.alias)),
  }));
  const byId = new Map(people.map((person) => [person.id, person]));
  const focus = new Map<number, FocusReason>();
  const asker = people.find((person) => person.tg_id === question.from.id);
  if (asker) focus.set(asker.id, "asking");
  const parentRow = replied ? chain.find((row) => row.msg_id === replied.message_id) : undefined;
  const parentAuthor =
    parentRow?.user_id ??
    (replied?.from && !replied.from.is_bot && !SERVICE_TG_IDS.includes(replied.from.id) ? people.find((person) => person.tg_id === replied.from!.id)?.id : undefined);
  if (parentAuthor !== undefined && !focus.has(parentAuthor) && byId.has(parentAuthor)) focus.set(parentAuthor, "replied to");
  // Telegram's copy of a replied-to message that is not stored still says who and what the question is about.
  const unstoredParent = replied && !parentStored ? (replied.text ?? replied.caption ?? "") : "";
  const threadTexts = [...thread.map((row) => row.text).reverse(), unstoredParent].filter(Boolean).map((text) => withoutMention(text, me));
  for (const id of namedIn([asked, ...threadTexts], named)) {
    if (!focus.has(id)) focus.set(id, "named");
  }
  const focusPeople = [...focus].slice(0, FOCUS_PEOPLE).map(([id, reason]) => ({ person: byId.get(id)!, reason }));
  const focusIds = focusPeople.map((entry) => entry.person.id);

  // Projects the question or its thread names, by any name they had; for a question about the rating that names none,
  // the asker's own.
  const projectNames: Named[] = projects.map((project) => {
    const names = [
      project.name,
      project.slug.replace(/-/g, " "),
      ...(projectAliases.get(project.id) ?? []).map((alias) => alias.alias),
      ...(formerOf.get(project.id) ?? []).map((entry) => entry.name),
    ];
    return { id: project.id, forms: [...new Set([...names, ...names.flatMap(transliterateName)])] };
  });
  let pickedIds = namedIn([asked, ...threadTexts], projectNames);
  if (pickedIds.length === 0 && asker && asksAboutRating(asked)) {
    pickedIds = projects.filter((project) => project.authors.some((author) => author.id === asker.id)).map((project) => project.id);
  }
  const picked = pickedIds.slice(0, DETAIL_PROJECTS).map((id) => projects.find((project) => project.id === id)!);

  const answers = options.recentAnswers ?? [];
  const visibleIds = new Set([...conversation, ...thread].map((row) => row.msg_id));
  const answerIds = answers.map((answer) => answer.msgId).filter((id): id is number => id !== undefined);
  const [focusFacts, exchanges, topics, breakdown, blanked] = await Promise.all([
    focusIds.length
      ? sql<FocusFact[]>`
          SELECT f.user_id, f.kind, f.value, f.status,
                 coalesce((SELECT max(m.sent_at) FROM messages m WHERE m.chat_id = f.chat_id AND m.msg_id = ANY(f.source_msg_ids)), f.created_at) AS said_at
          FROM facts f
          WHERE f.chat_id = ${chatId} AND f.user_id = ANY(${focusIds}) AND (f.status = 'manual' OR (f.status = 'auto' AND f.confidence >= ${MIN_VISIBLE_CONFIDENCE}))
          ORDER BY f.user_id, array_position(${[...FACT_KINDS]}::text[], f.kind), f.status = 'manual' DESC, f.confidence DESC, f.id`
      : Promise.resolve([]),
    focusIds.length
      ? sql<FocusExchange[]>`
          SELECT user_id, asked, media_type, answer, sent_at FROM (
            SELECT q.user_id, q.text AS asked, q.media_type, a.text AS answer, a.sent_at,
                   row_number() OVER (PARTITION BY q.user_id ORDER BY a.msg_id DESC) AS n
            FROM messages a JOIN messages q ON q.chat_id = a.chat_id AND q.msg_id = a.reply_to_msg_id
            WHERE a.chat_id = ${chatId} AND a.from_bot AND btrim(a.text) <> '' AND q.user_id = ANY(${focusIds})
          ) AS latest
          WHERE n <= ${FOCUS_EXCHANGES}
          ORDER BY sent_at`
      : Promise.resolve([]),
    focusIds.length
      ? sql<FocusTopic[]>`
          SELECT p.user_id, c.title, c.summary, c.period_to
          FROM unnest(${focusIds}::int[]) AS p(user_id)
          CROSS JOIN LATERAL (
            SELECT title, summary, period_to FROM chronicle
            WHERE chat_id = ${chatId} AND p.user_id = ANY(user_ids) AND importance >= 2 AND period_to > now() - ${`${FOCUS_TOPIC_DAYS} days`}::interval
            ORDER BY period_to DESC LIMIT ${FOCUS_TOPICS}
          ) AS c`
      : Promise.resolve([]),
    ratingBreakdown(sql, picked.map((project) => project.id)),
    // An answer whose stored text is gone (expired, or erased with /forgetme) is not repeated from memory either.
    answerIds.length
      ? sql<{ msg_id: number }[]>`SELECT msg_id FROM messages WHERE chat_id = ${chatId} AND msg_id = ANY(${answerIds}) AND btrim(text) = ''`
      : Promise.resolve([]),
  ]);

  const factsOf = new Map<number, Map<string, string[]>>();
  for (const fact of facts) {
    const kinds = factsOf.get(fact.user_id) ?? new Map<string, string[]>();
    kinds.set(fact.kind, [...(kinds.get(fact.kind) ?? []), fact.value]);
    factsOf.set(fact.user_id, kinds);
  }
  // peopleOfChat lists the most recently active first.
  const members = inContext.map((person) => {
    const who = safe(`${person.display_name}${person.username ? ` (@${person.username})` : ""}`);
    if (person.opted_out) return `- ${who}: asked not to collect anything about them`;
    const tagline = person.tagline ? ` — ${safe(person.tagline)}` : "";
    if (focusIds.includes(person.id)) return `- ${who}${tagline} | card in in_focus`;
    let room = MAX_FACTS_PER_MEMBER;
    const card = [...(factsOf.get(person.id) ?? new Map<string, string[]>())].flatMap(([kind, values]) => {
      const kept = values.slice(0, Math.max(0, room));
      room -= kept.length;
      return kept.length ? [`${kind.replace("_", " ")}: ${safe(kept.join(", "))}`] : [];
    });
    return `- ${who}${tagline}${card.length ? ` | ${card.join("; ")}` : ""}`;
  });

  const catalog = projects.slice(0, MAX_PROJECTS).map((project, index) => {
    const links = [project.links.repo, project.links.site, ...(project.links.other ?? [])].filter(Boolean).join(" ");
    const signals = project.recent_signals.map((signal) => signal.note).slice(0, 3);
    return safe(
      [
        `${index + 1}. ${project.name} — ${project.status.replace("_", " ")}, ${project.score} rating points, ${project.votes} vote(s)`,
        project.authors.length ? `by ${project.authors.map((author) => author.display_name).join(", ")}` : "",
        project.tagline ? `“${project.tagline}”` : "",
        project.stack.length ? `stack: ${project.stack.join(", ")}` : "",
        links ? `links: ${links}` : "",
        signals.length ? `recent: ${signals.join("; ")}` : "",
      ]
        .filter(Boolean)
        .join("; "),
    );
  });

  const topicsList = chronicle.map((entry) => `- ${dayOf(entry.period_to, clock.timezone)}: ${safe(`${entry.title} — ${entry.summary}`)}`);
  const catalogIndex = projects.findIndex((project) => [slugify(me.first_name), "waggle"].includes(project.slug) || project.name.toLowerCase() === me.first_name.toLowerCase());

  const threadLines = thread.map((row) => messageLine(row, clock, THREAD_CHARS));
  const repliedToBot = replied?.from?.id === me.id;
  if (replied && unstoredParent.trim() && !repliedToBot) {
    threadLines.push(`[${replied.message_id} ${timeLabel(new Date(replied.date * 1000), clock)}] ${safe(authorOf(replied, me))}: ${line(unstoredParent, THREAD_CHARS)}`);
  }
  const forgotten = new Set(blanked.map((row) => row.msg_id));
  const earlierAnswers = answers.filter((answer) => answer.msgId === undefined || (!visibleIds.has(answer.msgId) && !forgotten.has(answer.msgId)));
  const askerName = `${question.from.first_name}${question.from.last_name ? ` ${question.from.last_name}` : ""}${question.from.username ? ` (@${question.from.username})` : ""}`;
  const conversationLines = conversation.map((row) => messageLine(row, clock, referee ? SEGMENT_CHARS : MESSAGE_CHARS));

  return [
    `<chat title="${safe(question.chatTitle ?? "").replace(/"/g, "'")}" today="${clock.today}" timezone="${clock.timezone}" />`,
    aboutYouBlock({
      me,
      model: options.model,
      owners,
      aliasesOf,
      catalogEntry: catalogIndex >= 0 ? { project: projects[catalogIndex]!, rank: catalogIndex + 1, total: projects.length } : undefined,
    }),
    `<members>\n${members.join("\n") || "(none yet)"}\n</members>`,
    whoIsWhoBlock({ people: inContext, aliasesOf, projects: projects.slice(0, MAX_PROJECTS), projectAliases, former: formerOf, ambiguous: ambiguousNames(named) }),
    `<projects rating="best first">\n${catalog.join("\n") || "(none yet)"}\n</projects>`,
    `<chronicle days="${CHRONICLE_DAYS}" order="newest first">\n${topicsList.join("\n") || "(nothing yet)"}\n</chronicle>`,
    projectDetailsBlock({ ranked: projects, picked, breakdown, former: formerOf, clock }),
    inFocusBlock({
      focus: focusPeople,
      facts: groupBy(focusFacts, (fact) => fact.user_id),
      exchanges: groupBy(
        exchanges.map((exchange) => ({ ...exchange, asked: withoutMention(exchange.asked, me) })),
        (exchange) => exchange.user_id,
      ),
      topics: groupBy(topics, (topic) => topic.user_id),
      projects,
      clock,
    }),
    referee
      ? `<current_conversation note="everything since the last pause of 25 minutes or more, oldest first">\n${conversationLines.join("\n") || "(none)"}\n</current_conversation>`
      : `<recent_messages>\n${conversationLines.join("\n") || "(none)"}\n</recent_messages>`,
    earlierAnswers.length
      ? `<your_recent_answers>\n${earlierAnswers.map((answer) => `- to ${safe(answer.to)}: ${line(answer.text, 600)}`).join("\n")}\n</your_recent_answers>`
      : "",
    threadLines.length ? `<thread note="the messages the question replies to, root first">\n${threadLines.join("\n")}\n</thread>` : "",
    // A message of the bot's from before it kept its own messages: Telegram's copy stands in.
    repliedToBot && unstoredParent ? `<your_message_they_reply_to>\n${line(unstoredParent, 1500)}\n</your_message_they_reply_to>` : "",
    `<if_insulted motif="${options.insultMotif}" />`,
    `<question from="${safe(askerName).replace(/"/g, "'")}">\n${line(asked, 1500)}\n</question>`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
