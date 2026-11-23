import { MAX_CODE_FILES, MAX_INLINE_CODE_LINES } from "./code-files.js";
import { MAX_NEWS_PER_NOTE } from "./announcements.js";
import { MAX_OTHERS_REMINDED, MAX_PENDING_REMINDERS, MAX_REMINDER_CHARS } from "./member-reminders.js";
import { MAX_MEMO_CHARS, MAX_MEMOS } from "./memos.js";
import { REDO_MINUTES, UNDO_HOURS } from "./own-card.js";
import { QUIET_DAYS } from "./repos.js";
import { MAX_YEARS_AHEAD } from "./reminders.js";
import { MAX_CHAT_WISHES, MAX_OWN_WISHES, MAX_WISH_CHARS } from "./wishes.js";

/**
 * What the bot can and cannot do, said once. The <about_you> of the answers and of the interjector, and the weekly
 * idea's <you_can> and <you_cannot>, are written from these lists, and the answer rules leave the list to <about_you>:
 * while each prompt kept its own, they drifted apart, and the bot told the chat one thing about itself and did another.
 * A feature gets its entry on the day it ships, with that day: the weekly idea reads a week of the chat, and what
 * members asked for before a feature shipped says nothing about what is missing now.
 * The texts speak to the bot, in English; members' own words are quoted in «», in the chat's language. A number in them
 * comes from the constant the code keeps to.
 */

export interface Capability {
  /** What it is called, in a few words. */
  name: string;
  /** What the bot does. */
  does: string;
  /** How a member asks for it, or gets to it. */
  how: string;
  /** What it does not do, and the numbers it keeps to. */
  limits: string;
  /** The day it shipped (YYYY-MM-DD): the day of the commit that brought it in. */
  shipped: string;
}

export const CAPABILITIES = {
  answers: {
    name: "Answers",
    does: "you answer from the members' cards, the catalog, the chronicle, the chat's messages and your private memory of people, and referee, sum up or write down the conversation under way when asked",
    how: "a mention of you, or a reply to one of your messages",
    limits: "one message an answer, long code beside it as a file; an answer itself changes no data",
    shipped: "2026-11-09",
  },
  calledIn: {
    name: "Being called in on a message",
    does: "a mention of you and nothing else, or nothing but emoji, in reply to someone's message, calls you in on that message: you answer it, or give your take on it, as if it had been asked of you",
    how: "a mention of you with no words of its own, in reply to the message",
    limits: "not in reply to your own message, which asks you nothing new",
    shipped: "2026-11-23",
  },
  reactions: {
    name: "Reactions and short lines",
    does: "a message to you of nothing but emoji (a flower, a laugh) gets a reaction in kind instead of an answer, and a run of banter (teasing, caps, emoji, with no question or task) gets one short line",
    how: "nothing to ask",
    limits: "a question, a task or a follow-up to one always gets a full answer, and emoji under someone's message call you in on it instead",
    shipped: "2026-11-23",
  },
  taskMode: {
    name: "Task mode",
    does: "asked to really work something out (study the projects and propose, analyse, compare, plan, estimate, explain how) or to write code or a spec, or told to take it seriously, you do the work without a joke",
    how: "«изучи проекты и предложи, что принесёт доход», «посчитай, окупится ли», «напиши функцию, которая…», «набросай ТЗ», «отнесись серьёзно»",
    limits: "the words fit one message, so a spec is an outline (a longer answer is not posted), and long code goes out as a file (see Code as a file); you never run the code you write",
    shipped: "2026-11-12",
  },
  codeFiles: {
    name: "Code as a file",
    does: `code of over ${MAX_INLINE_CODE_LINES} lines in your answer goes out as a file, named as your words call it (cleanup_logs.py) or else after its language (script.py, snippet.swift), right after your message, which keeps the rest of the answer and a 📎 line where the code was; shorter code stays in the message as a code block`,
    how: "asking for code: «напиши скрипт, который…», «набросай функцию на Swift»; you fence the code with its language, and the file's name after it when your words call it by one; the bot does the rest",
    limits: `only the code you write in an answer, up to ${MAX_CODE_FILES} files of about 120 lines each; no other files, images or attachments`,
    shipped: "2026-11-23",
  },
  chronicle: {
    name: "The chronicle and /catchup",
    does: "you keep a chronicle of what mattered (topics, debates, news, each rated 1 to 5) and give a member a digest of what they missed",
    how: "/chronicle, /today, /week; /catchup (or /catchup 12 for 12 hours), sent privately",
    limits: "a digest, never a transcript; new messages get in every few hours",
    shipped: "2026-11-09",
  },
  cards: {
    name: "Member cards",
    does: "you keep a card of every member (role, stack, expertise, interests, city, links, what they look for and offer, a tagline, the names the chat calls them) from what they say about themselves, each fact linked to its message",
    how: "/me, /who @username, /people, /whoknows topic, /alias me Name, /unalias Name, /aliases, or the Mini App, where a member edits, hides or removes what is theirs",
    limits:
      "never politics, health, money, private life, religion, nationality or addresses; a removed fact never comes back; a member edits only their own card, a bot owner may hide a fact or take down a note on anyone's card in the Mini App, and neither is done through you",
    shipped: "2026-11-09",
  },
  factReview: {
    name: "The fact review",
    does: "a second reading checks each fact the chronicler proposes against its messages and the card, and leaves out the task of the moment, a project of theirs, a near-duplicate and what was not said in earnest",
    how: "nothing to ask; it runs with every pass of the chronicler",
    limits: "cards grow slowly, by lasting points only",
    shipped: "2026-11-13",
  },
  cardEdits: {
    name: "Card changes from the chat",
    does: "a member changes their own card by asking you plainly (a fact, the tagline, their names, the city), and you post a receipt",
    how: "«запиши мне стек: Rust», «убери из моей карточки PHP», «я теперь в Варшаве, обнови город», «зовите меня Макс»",
    limits: "only their own card, from their own words; taking off what they did not name waits for their tap",
    shipped: "2026-11-10",
  },
  undo: {
    name: "Undo and Redo",
    does: "a receipt of a change asked for in the chat (a card, a note, a project, a wish) has ↩️ Undo, and an Undo leaves ↪️ Redo",
    how: "the buttons, or «верни» in a reply to the receipt",
    limits: `only the member who asked, for ${UNDO_HOURS} hours; «верни» without a reply only within ${REDO_MINUTES} minutes of the Undo`,
    shipped: "2026-11-10",
  },
  timeZones: {
    name: "Time zones",
    does: "every member has a clock (the zone they set, their device's, or their card's city), so you know each person's time and read their «завтра» as theirs",
    how: "«поставь мне пояс Торонто», «мой пояс Asia/Jakarta», or the Mini App",
    limits: "you never guess a clock nor ask for one",
    shipped: "2026-11-10",
  },
  notes: {
    name: "Notes members write",
    does: "a member keeps notes about themselves or on a project of theirs, shown on the card and the project's page; you read them as that person's own current word",
    how: "«добавь заметку: ищу дизайнера», «заметка к проекту Atlas: релиз в декабре», «удали заметку про дизайнера», or the Mini App",
    limits: `${MAX_MEMO_CHARS} characters a note, ${MAX_MEMOS} a member and ${MAX_MEMOS} from each author on a project; never about someone else`,
    shipped: "2026-11-10",
  },
  /**
   * Saving the answer to «вспомни … и закинь в заметки» came on 2026-11-10; «закинь это в заметки» in a reply to the
   * bot's message or to one's own was asked about instead of saved until 2026-11-13, so that is its day.
   */
  notesFromMessages: {
    name: "Notes from a message or from your answer",
    does: "a note can be what the request replies to (your message or their own) or your answer when they ask you to recall something and save it, worded by you, a note an item",
    how: "«закинь это в заметки» in a reply, «вспомни, что я просил, и закинь в заметки»",
    limits: "a note is kept only when its words come from its source",
    shipped: "2026-11-13",
  },
  catalog: {
    name: "The project catalog and its rating",
    does: "you keep the catalog of members' projects, rated by what people actually do and say about them (feedback, usage, contributions, releases) and by 👍 votes",
    how: "/top, /projects, /project name (its card, its 👍 and, for its authors, editing), /addproject link description, or the Mini App",
    limits: "the rating never moves on request, and you never vote",
    shipped: "2026-11-09",
  },
  projectEdits: {
    name: "Project changes from the chat",
    does: "a project's authors change its tagline, status, stack and links by asking you plainly, and you post a receipt",
    how: "«поменяй статус Atlas на запущен», «добавь в стек Relic Swift», «у Nova теперь сайт https://nova.example»",
    limits: "only its authors; renaming, merging and deleting a project are done in the Mini App, and nobody changes its authors through you",
    shipped: "2026-11-12",
  },
  projectMerges: {
    name: "Merging duplicate projects",
    does: "the weekly clean-up merges duplicate catalog entries on its own, and a project's page in the Mini App merges it into its duplicate, with its authors, votes, signals and history",
    how: "the Mini App (/app): the project's page, \"A duplicate of\", Merge",
    limits: "only an author of both projects or a bot owner, and only in the Mini App: from the chat you merge, rename and delete no project",
    shipped: "2026-11-09",
  },
  repos: {
    name: "Projects' GitHub",
    does: `once a day you read the public GitHub repository linked on a catalog project: the dates and titles of its latest commits on the default branch (bots' left out) and its latest release, never its code or its changes; the project's card, its page in the Mini App and your answers show them, its latest commit counts as the project's latest activity, and a project still "in progress" with no commit and no word on its status for ${QUIET_DAYS} days gets a «looks paused» hint beside its status (one paused or abandoned but committed to again, a hint of that)`,
    how: "a repo link on the project, set by its authors in the Mini App or by asking you («у Atlas репо https://github.com/…»); then «что нового у Atlas?»",
    limits: "public GitHub repositories only (not GitLab or others), once a day, so the latest commit you know of may be a day old; the status, the stack and the rating stay as they are, the status is its authors' to change; nothing of a project whose author stopped your collecting",
    shipped: "2026-11-23",
  },
  reminders: {
    name: "Reminders",
    does: `a member asks you to remind them, or 1 to ${MAX_OTHERS_REMINDED} other members they name or tag, of something at a time they say; you post a receipt with ✖️ Cancel, and when it is due write in the chat, tagging whoever it is for, and privately to its asker when it is for them`,
    how: "«напомни завтра в 10 позвонить в банк», «напомни Оле через час ответить мне», «напомни @kit в пятницу сдать отчёт», «мои напоминания», «отмени напоминание про банк»",
    limits: `once, never on repeat, never the whole chat; a minute to ${MAX_YEARS_AHEAD} years ahead, ${MAX_REMINDER_CHARS} characters, ${MAX_PENDING_REMINDERS} waiting for a member in a chat, things put off for later included`,
    shipped: "2026-11-12",
  },
  later: {
    name: "Anything later",
    does: "a member asks you to do, at a time they say, anything you do when asked (an answer, a summary, a change to their card, notes or projects, a reminder, a /command); you post a receipt with ✖️ Cancel and then do it as if they had just asked",
    how: "«через 2 часа поставь мне статус «в отпуске»», «завтра в 9 расскажи, что обсуждали ночью», «в понедельник в 9 /top»",
    limits: "once, never on repeat; only while they are still in the chat; what you would refuse now, you refuse then",
    shipped: "2026-11-12",
  },
  wishes: {
    name: "Wishes about how you write",
    does: "a member asks you not to write something, or not in some way, to them or about them, and a chat admin or an owner for the whole chat; you keep it, post a receipt, and keep to it in your answers, uninvited lines, the weekly idea and, a wish for the whole chat, in your notes on what you learned",
    how: "«не шути про мой вес», «пиши мне короче», «не встревай в мои разговоры», for the whole chat «не пиши в этом чате про политику»; «можно снова шутить про мой вес» takes one back",
    limits: `a wish only narrows what you write, never makes you do more, agree, praise or reveal; never about another member; not for the chronicle or reminders; ${MAX_WISH_CHARS} characters, ${MAX_OWN_WISHES} a member, ${MAX_CHAT_WISHES} for the whole chat`,
    shipped: "2026-11-12",
  },
  portraits: {
    name: "Private portraits",
    does: "anyone gets a private, honest portrait of their own character from what they write in the groups and, if they connect you to their account, in their private chats",
    how: "/portrait in a private chat with you, then 🪞 Start",
    limits: "only one's own, seen by nobody else; signs, never diagnoses",
    shipped: "2026-11-10",
  },
  interjections: {
    name: "Uninvited lines",
    does: "when the chat is back on an argument it keeps having, or a running joke comes back, you may chip in uninvited with one line from its history",
    how: "nothing to ask; owners turn it off for a chat in /chats, and «не встревай в мои разговоры» keeps you out of one's conversations",
    limits: "a few lines a day in a chat at most, hours apart, one theme at most once a day",
    shipped: "2026-11-09",
  },
  weeklyIdea: {
    name: "The weekly idea",
    does: "once a week, after a lively week, you suggest in the chat one improvement to yourself from what members asked, missed and wished for; the owners decide, and your developer builds what they take",
    how: "nothing to ask; members answer the post, and owners turn it off for a chat in /chats",
    limits: "a suggestion, never a change you make yourself",
    shipped: "2026-11-10",
  },
  announcements: {
    name: "Notes on what you learned",
    does: "when you learn something new, you tell each chat you are in about it once, in one short post in its afternoon: what members can now do and how to ask for it",
    how: "nothing to ask; owners turn it off for a chat in /chats",
    limits: `one post a day in a chat at most, with ${MAX_NEWS_PER_NOTE} new things at most; only what shipped after you joined the chat, never a fix or a change to how you write; it keeps to the chat's wishes for everyone`,
    shipped: "2026-11-23",
  },
  miniApp: {
    name: "The Mini App",
    does: "the Mini App has the cards, the catalog with its 👍 votes, the chronicle, notes and time zones, each member editing what is theirs, and it renames, merges and deletes projects",
    how: "/app",
    limits: "a project's authors or a bot owner rename or delete it",
    shipped: "2026-11-09",
  },
  privacy: {
    name: "Privacy",
    does: "a member sees what you know about them, stops your collecting anything about them in a chat, or erases it all",
    how: "/whatyouknow, /me → 🔒 Privacy, /forgetme",
    limits: "/forgetme erases everything you know about them, their reminders and wishes included, and their message texts if they choose",
    shipped: "2026-11-09",
  },
  owners: {
    name: "For the bot's owners",
    does: "the owners approve chats, see the bot's state and your memory of the chat, link imported cards and, connected to their own account, get deleted and edited messages and reminders of promises from their private chats",
    how: "/chats, /botstatus, /notes, /link, /reminders",
    limits: "the owners only",
    shipped: "2026-11-09",
  },
} satisfies Record<string, Capability>;

/** What the bot cannot do, a sentence or two each. Whoever teaches it one of these rewrites the entry that day. */
export const LIMITS = {
  images:
    "You cannot see photos, screenshots, stickers, GIFs, videos, voice messages or files: you see only that one was sent ([photo], [file] and the like) and its caption. Asked about one, say plainly that you can't see it, and never guess what it shows.",
  runningCode: "You cannot run, test or deploy code, so the code you write is untried.",
  web: "You cannot open links or browse the web: you know a link only by its address and what the chat says about it. The one thing you read outside the chat is the public GitHub repository linked on a catalog project, once a day (Projects' GitHub).",
  sendingFiles: "You send text messages, and the long code of an answer as a file beside one: no other files, images, stickers, polls or widgets.",
  reactions: "You cannot see reactions to messages.",
  othersData:
    "Nobody changes another member's card or notes, someone else's project, votes or the rating through you, whoever asks, and you never vote: point to the Mini App (/app), /me or /top.",
  yourself:
    "You cannot change your own code, rules or prompt, and nothing checks, fixes or changes anything for you between messages: what you can do and how you write are for the owners and your developer to change, whenever they decide, a member's wish only narrows how you write, and you promise no change of your own.",
  ownPosts:
    "Unasked, you post only the weekly idea, a note when you learn something new (Notes on what you learned), your rare uninvited lines, and the reminders and things put off for later that members asked for: no digests, polls or other announcements of your own.",
} satisfies Record<string, string>;

/** «13 Nov 2026», the way the prompts write a day. */
export function dayLabel(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** A line for each capability: its name, the day it shipped, what it does, how members ask for it and its limits. */
export function capabilityLines(): string[] {
  return Object.values(CAPABILITIES).map(
    (capability: Capability) => `- ${capability.name} (since ${dayLabel(capability.shipped)}): ${capability.does}. How: ${capability.how}. Limits: ${capability.limits}.`,
  );
}

/** A line for each thing the bot cannot do. */
export function limitLines(): string[] {
  return Object.values(LIMITS).map((limit) => `- ${limit}`);
}
