import type Anthropic from "@anthropic-ai/sdk";
import type { Message, UserFromGetMe } from "grammy/types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createBot } from "../src/bot/bot.js";
import { asksAboutRating, buildReplyContext, promptText, refersToConversation, type Question } from "../src/bot/reply-context.js";
import { addAlias, ambiguousNames, mentionsName, nameForms, namedIn, wordsOf } from "../src/core/aliases.js";
import { migrateChat } from "../src/core/chat-migration.js";
import { attachLegacyData, LEGACY_CHAT_ID, registerChat, setChatStatus } from "../src/core/chats.js";
import { catchupFor } from "../src/core/chronicle.js";
import type { Config } from "../src/core/config.js";
import { createSql, migrate, type Sql } from "../src/core/db.js";
import { proposeFact, type FactKind } from "../src/core/facts.js";
import { mergeSeedUser } from "../src/core/merge.js";
import { saveBotMessage, saveMessage } from "../src/core/messages.js";
import { addUserProject, mergeProjects, renameProject, updateProject } from "../src/core/projects.js";
import { hasForbiddenTopic, transliterateName } from "../src/core/text.js";
import { forgetUser, getPerson, resolveUser, setOptOut, type User } from "../src/core/users.js";
import { EXTRACTABLE_KINDS, EXTRACTION_SYSTEM_PROMPT, INTERRUPTED_PASS_ERROR, runExtractionPass, type ExtractionResult } from "../src/worker/extract.js";
import { nextExtractionRetryAt } from "../src/worker/scheduler.js";
import { NOTES_SYSTEM_PROMPT } from "../src/worker/notes-extract.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const TOKEN = "123456:TEST-TOKEN";
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const OWNER = 9801;

describe("names in messages", () => {
  it("spell a name in the other alphabet, both ways", () => {
    expect(transliterateName("Gleb")).toEqual(["Глеб"]);
    expect(transliterateName("Тор")).toEqual(["Tor"]);
    expect(transliterateName("Anatoliy")).toEqual(["Анатолий"]);
    expect(transliterateName("Kseniya")).toEqual(["Ксения"]);
    expect(transliterateName("Юлия")).toEqual(["Yuliya"]);
    expect(transliterateName("Kit Котов")).toEqual(["Kit Kotov", "Кит Котов"]);
    expect(transliterateName("🦊")).toEqual([]);
  });

  it("find a name the way a Russian sentence inflects it, and nothing that only starts like it", () => {
    const words = wordsOf("Спроси у Глеба и Тору, а про Китай не надо; Анатолию тоже");
    expect(mentionsName(words, "Глеб")).toBe(true);
    expect(mentionsName(words, "Тор")).toBe(true);
    expect(mentionsName(words, "Анатолий")).toBe(true);
    expect(mentionsName(words, "Кит")).toBe(false);
    expect(mentionsName(wordsOf("а что Маше скажем?"), "Маша")).toBe(true);
    expect(mentionsName(wordsOf("Ли сказал"), "Ли")).toBe(false);
  });

  it("name people by any form of their name, by an alias and by @username, in the order the texts come", () => {
    const gleb = { id: 1, forms: nameForms("Gleb", ["Громовержец"]), username: "thunder_x" };
    const tor = { id: 2, forms: nameForms("Тор") };
    const kit = { id: 3, forms: nameForms("Kit") };
    expect(namedIn(["а что Громовержец думает?"], [gleb, tor, kit])).toEqual([1]);
    expect(namedIn(["спроси Глеба", "Tor said so"], [kit, tor, gleb])).toEqual([1, 2]);
    expect(namedIn(["ask @thunder_x"], [gleb, tor])).toEqual([1]);
    expect(namedIn(["the thunder_x account"], [gleb])).toEqual([]);
  });

  it("flag a name that fits several people, across both alphabets", () => {
    const groups = ambiguousNames([
      { id: 1, forms: nameForms("Maestro", ["Митя"]) },
      { id: 2, forms: nameForms("Mitya") },
      { id: 3, forms: nameForms("Gleb") },
    ]);
    expect(groups).toEqual([{ names: ["Митя", "Mitya"], ids: [1, 2] }]);
  });

  it("tell a question about the conversation itself and a question about the rating", () => {
    for (const text of [
      "рассуди нас", "кто из них прав?", "кто из нас круче", "о чём спор?", "что за спор тут", "разреши спор", "кто выиграл?",
      "запиши этот диалог как исторический", "о чем речь ведете", "что тут происходит", "о чём вы тут?", "мы тут обсуждаем Rust", "перепалка дня", "прочитай тред",
      "who is right?", "settle this", "what are they arguing about", "what's going on here", "summarize this conversation", "these debates again",
    ]) {
      expect(refersToConversation(text), text).toBe(true);
    }
    for (const text of ["потерял рассудок", "кто правда так думает", "иду на спорт", "речка рядом", "что нового?"]) expect(refersToConversation(text), text).toBe(false);
    for (const text of ["почему такой рейтинг?", "сколько баллов у меня", "кто в топе", "what's my score", "how many votes"]) expect(asksAboutRating(text), text).toBe(true);
    for (const text of ["топить за Claude", "что нового?"]) expect(asksAboutRating(text), text).toBe(false);
  });
});

describe("forbidden topics", () => {
  it("block suicide, marriage, citizenship and documents, sleep and death, the word «зп»", () => {
    for (const value of [
      "суицидальные мысли", "самоубийство", "он женат", "неженат пока", "вышла замуж", "получил гражданство", "паспорт потерял", "ВНЖ в Испании",
      "вид на жительство", "бессонница замучила", "недосып жуткий", "похороны в субботу", "похоронное бюро", "скончался вчера", "какая у тебя зп?",
      "suicide", "applied for citizenship", "my passport", "insomnia again", "the funeral",
    ]) {
      expect(hasForbiddenTopic(value), value).toBe(true);
    }
  });

  it("let tech look-alikes through: documentation, the death of a project, burying a feature, Passport.js", () => {
    for (const value of [
      "документация к API", "тепловая смерть вселенной", "смерть проекта", "спать не будем, пока не починим прод", "похоронили фичу", "проект похоронен",
      "Passport.js", "passport-jwt strategy", "зпт", "зппп",
    ]) {
      expect(hasForbiddenTopic(value), value).toBe(false);
    }
  });
});

describe("chronicler kinds", () => {
  it("collect what people look for and can help with, within work, projects and skills", () => {
    expect(EXTRACTABLE_KINDS).toContain("looking_for");
    expect(EXTRACTABLE_KINDS).toContain("can_help");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("- looking_for —");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("never money, a job as a source of income, housing or dating");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain(`lines from "Waggle (bot)"`);
  });
});

describe.skipIf(!DATABASE_URL)("memory of the conversation", () => {
  let sql: Sql;
  let nextChat = -1001000000200;
  let nextTgId = 9810;
  let nextMsgId = 50_000;
  const now = () => Math.floor(Date.now() / 1000);
  const me = { id: 42, is_bot: true, first_name: "Waggle", username: "waggle_test_bot", can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false } as unknown as UserFromGetMe;

  beforeAll(async () => {
    sql = createSql(DATABASE_URL!);
    await sql`DROP SCHEMA public CASCADE`;
    await sql`CREATE SCHEMA public`;
    await migrate(sql);
  });

  afterAll(async () => {
    await sql?.end();
  });

  async function newChat(title = "Hive"): Promise<number> {
    nextChat -= 1;
    await registerChat(sql, nextChat, title, null);
    await setChatStatus(sql, nextChat, "approved", null);
    return nextChat;
  }

  async function member(chatId: number, firstName: string, options: { username?: string; tgId?: number; admins?: number[] } = {}): Promise<User> {
    return resolveUser(sql, { id: options.tgId ?? ++nextTgId, first_name: firstName, username: options.username }, options.admins ?? [], chatId);
  }

  async function say(chatId: number, user: User | null, text: string, options: { at?: Date; replyTo?: number; toBot?: boolean } = {}): Promise<number> {
    const msgId = ++nextMsgId;
    await saveMessage(sql, {
      chatId, msgId, userId: user?.id ?? null, sentAt: options.at ?? new Date(), text, replyToMsgId: options.replyTo ?? null, replyToBot: options.toBot,
      isForward: false, forwardSource: null, mediaType: null,
    });
    return msgId;
  }

  async function botSays(chatId: number, text: string, options: { at?: Date; replyTo?: number } = {}): Promise<number> {
    const msgId = ++nextMsgId;
    await saveBotMessage(sql, { chatId, msgId, sentAt: options.at ?? new Date(), text, replyToMsgId: options.replyTo ?? null });
    return msgId;
  }

  async function fact(chatId: number, user: User, kind: FactKind, value: string): Promise<void> {
    await proposeFact(sql, { chatId, userId: user.id, kind, value, confidence: 1, sourceMsgIds: [], source: "user" });
  }

  const asking = (chatId: number, from: User, text: string, extra: Record<string, unknown> = {}): Question => {
    const tgFrom = { id: from.tg_id!, is_bot: false, first_name: from.display_name, username: from.username ?? undefined };
    return {
      chatId,
      chatTitle: "Hive",
      from: tgFrom,
      me,
      message: { message_id: ++nextMsgId, date: now(), chat: { id: chatId, type: "supergroup", title: "Hive" }, from: tgFrom, text, ...extra } as unknown as Message,
    };
  };

  const contextFor = (question: Question, model = "claude-opus-5-5") =>
    buildReplyContext(sql, question, { timezone: "UTC", model, ownerTgIds: [OWNER], recentAnswers: [], insultMotif: "the scrolls are sealed" }).then(promptText);

  const block = (context: string, name: string) => new RegExp(`<${name}[^>]*>\\n([\\s\\S]*?)\\n</${name}>`).exec(context)?.[1];

  describe("the answer context", () => {
    it("says who the bot is: its owner and the names they go by, what it can do, its place in the catalog and the model", async () => {
      const chat = await newChat();
      const owner = await member(chat, "Maestro", { username: "maestro_owner", tgId: OWNER, admins: [OWNER] });
      const kit = await member(chat, "Kit");
      await addAlias(sql, { chatId: chat, target: { userId: owner.id }, alias: "Капитан", source: "owner" });
      await addUserProject(sql, { chatId: chat, name: "Waggle", actorUserId: owner.id });
      const atlas = await addUserProject(sql, { chatId: chat, name: "Atlas", actorUserId: kit.id });
      await sql`INSERT INTO votes (project_id, user_id) VALUES (${atlas.project.id}, ${owner.id})`;

      // The bot's own @username in the thread does not name the project called like the bot.
      const earlier = await say(chat, kit, "@waggle_test_bot ты кто такой?");
      const parent = { message_id: earlier, date: now(), chat: { id: chat, type: "supergroup", title: "Hive" }, from: { id: kit.tg_id!, is_bot: false, first_name: "Kit" }, text: "@waggle_test_bot ты кто такой?" };
      const context = await contextFor(asking(chat, kit, "кто тебя сделал?", { reply_to_message: parent }));
      expect(context).not.toContain("<project_details>");
      const about = block(context, "about_you")!;
      expect(about).toContain("You are Waggle (@waggle_test_bot)");
      expect(about).toContain("written by claude-opus-5-5");
      expect(about).toContain("Your owner, who built you and pays for you: Maestro (@maestro_owner), also called Капитан.");
      expect(about).toContain("by asking you plainly in the chat: you do it and post a receipt with ↩️ Undo");
      expect(about).toContain("Nobody changes anyone else's data, a project's catalog entry, votes or the rating through you, and you do not vote, run code, browse the web or send images or widgets.");
      expect(about).toContain("/forgetme");
      expect(about).toContain("In the catalog you are the project Waggle: #2 of 2, 0 rating points, 0 vote(s).");
    });

    it("lists who is who: other spellings, aliases with who gave them, a project's old name, and names that fit several people", async () => {
      const chat = await newChat();
      const owner = await member(chat, "Maestro", { tgId: OWNER, admins: [OWNER] });
      const gleb = await member(chat, "Gleb");
      await member(chat, "Тор");
      await member(chat, "Mitya");
      const kit = await member(chat, "Kit");
      await addAlias(sql, { chatId: chat, target: { userId: owner.id }, alias: "Митя", source: "owner" });
      await addAlias(sql, { chatId: chat, target: { userId: gleb.id }, alias: "Громовержец", source: "owner" });
      await addAlias(sql, { chatId: chat, target: { userId: gleb.id }, alias: "Thunder", source: "person" });
      const orbit = await addUserProject(sql, { chatId: chat, name: "Orbit", actorUserId: kit.id });
      await renameProject(sql, { chatId: chat, projectId: orbit.project.id, name: "Atlas", source: "user", actorUserId: kit.id });
      await addAlias(sql, { chatId: chat, target: { projectId: orbit.project.id }, alias: "Атлас", source: "person" });

      const who = block(await contextFor(asking(chat, kit, "кто такой Митя?")), "who_is_who")!.split("\n");
      expect(who).toContain("Gleb: Глеб, Громовержец (owner), Thunder (self)");
      expect(who).toContain("Тор: Tor");
      expect(who).toContain("#atlas Atlas: Атлас (author), was Orbit");
      expect(who).toContain("“Митя” / “Mitya” may mean Maestro or Mitya");
      expect(who.some((line) => line.includes("@"))).toBe(false);
    });

    it("puts a time on every message line, with the date when it was not today", async () => {
      const chat = await newChat();
      const kit = await member(chat, "Kit");
      const longAgo = new Date(Date.now() - 400 * DAY);
      const lastWeek = new Date(Date.now() - 3 * DAY);
      const justNow = new Date(Date.now() - MINUTE);
      const old = await say(chat, kit, "a message from last year", { at: longAgo });
      const recent = await say(chat, kit, "a message from this week", { at: lastWeek });
      const fresh = await say(chat, kit, "a message from a minute ago", { at: justNow });
      const lines = block(await contextFor(asking(chat, kit, "что нового?")), "recent_messages")!.split("\n");
      const today = new Date().toISOString().slice(0, 10);
      const time = (at: Date) => at.toISOString().slice(11, 16);
      const date = (at: Date, withYear: boolean) => at.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" });
      expect(lines[0]).toBe(`[${old} ${date(longAgo, true)} ${time(longAgo)}] Kit: a message from last year`);
      const sameYear = lastWeek.toISOString().slice(0, 4) === today.slice(0, 4);
      expect(lines[1]).toBe(`[${recent} ${date(lastWeek, !sameYear)} ${time(lastWeek)}] Kit: a message from this week`);
      const freshLabel = justNow.toISOString().slice(0, 10) === today ? time(justNow) : `${date(justNow, false)} ${time(justNow)}`;
      expect(lines[2]).toBe(`[${fresh} ${freshLabel}] Kit: a message from a minute ago`);
    });

    it("follows the reply chain to its root, the bot's own messages included, instead of the bot's text from Telegram", async () => {
      const chat = await newChat();
      const kit = await member(chat, "Kit");
      const bob = await member(chat, "Bob");
      const root = await say(chat, kit, "кто здесь пишет на Rust?", { at: new Date(Date.now() - 2 * DAY) });
      const answer = await botSays(chat, "Bob пишет на Rust, а ты пока только спрашиваешь", { replyTo: root, at: new Date(Date.now() - 2 * DAY + MINUTE) });
      const reply = await say(chat, kit, "обидно, но справедливо", { replyTo: answer, toBot: true });
      const comeback = await botSays(chat, "справедливость — моя вторая работа", { replyTo: reply });
      for (let index = 0; index < 35; index += 1) await say(chat, bob, `unrelated chatter ${index}`);
      const parent = { message_id: comeback, date: now(), chat: { id: chat, type: "supergroup", title: "Hive" }, from: me, text: "справедливость — моя вторая работа" };
      const context = await contextFor(asking(chat, bob, "а первая какая?", { reply_to_message: parent }));
      const thread = block(context, "thread")!.split("\n");
      expect(thread.map((line) => /^\[(\d+) /.exec(line)![1])).toEqual([String(root), String(answer), String(reply), String(comeback)]);
      expect(thread[0]).toMatch(/\] Kit: кто здесь пишет на Rust\?$/);
      expect(thread[1]).toMatch(new RegExp(`\\] Waggle ↩${root}: Bob пишет на Rust`));
      expect(thread[2]).toMatch(/\] Kit ↩Waggle: обидно, но справедливо$/);
      expect(context).not.toContain("<your_message_they_reply_to>");
      // The thread reaches beyond the 30 recent messages, which no longer hold its start.
      expect(block(context, "recent_messages")).not.toContain("кто здесь пишет на Rust");

      const unstored = { message_id: 1, date: now(), chat: parent.chat, from: me, text: "an answer from before the log" };
      const fallback = await contextFor(asking(chat, bob, "what?", { reply_to_message: unstored }));
      expect(block(fallback, "your_message_they_reply_to")).toBe("an answer from before the log");
      expect(fallback).not.toContain("<thread");
    });

    it("gives the people in focus their whole card with dates, their projects, their talks with the bot and their topics", async () => {
      const chat = await newChat();
      const kit = await member(chat, "Kit", { username: "kit_k" });
      const bob = await member(chat, "Bob");
      const gleb = await member(chat, "Gleb");
      await member(chat, "Тор");
      const dora = await member(chat, "Dora", { username: "dora_d" });
      const hidden = await member(chat, "Quiet");
      await setOptOut(sql, hidden.id, true, chat);
      await addAlias(sql, { chatId: chat, target: { userId: gleb.id }, alias: "Громовержец", source: "owner" });
      const stack = ["Rust", "Go", "Swift", "Kotlin", "Elixir", "Zig", "OCaml", "Haskell", "Scala", "Dart", "Lua", "Julia", "Nim", "Crystal"];
      for (const value of stack) await fact(chat, kit, "stack", value);
      await fact(chat, dora, "interest", "climbing");
      await addUserProject(sql, { chatId: chat, name: "Atlas", actorUserId: kit.id, status: "launched" });
      const asked = await say(chat, kit, "who knows Rust here?", { at: new Date(Date.now() - DAY) });
      await botSays(chat, "you do, apparently", { replyTo: asked, at: new Date(Date.now() - DAY + MINUTE) });
      const [run] = await sql<{ id: number }[]>`INSERT INTO extraction_runs (chat_id) VALUES (${chat}) RETURNING id`;
      await sql`
        INSERT INTO chronicle (chat_id, run_id, period_from, period_to, title, summary, user_ids, importance)
        VALUES (${chat}, ${run!.id}, now() - interval '3 days', now() - interval '3 days', 'Rust vs Go', 'Kit argued for Rust.', ${[kit.id]}, 3),
               (${chat}, ${run!.id}, now() - interval '90 days', now() - interval '90 days', 'Ancient history', 'Too old to count.', ${[kit.id]}, 3)`;
      const bobs = await say(chat, bob, "Тор говорит, что Swift лучше");

      const replyToBob = { message_id: bobs, date: now(), chat: { id: chat, type: "supergroup", title: "Hive" }, from: { id: bob.tg_id!, is_bot: false, first_name: "Bob" }, text: "Тор говорит, что Swift лучше" };
      const context = await contextFor(asking(chat, kit, "а Громовержец что думает? и Quiet тоже", { reply_to_message: replyToBob }));
      const focus = block(context, "in_focus")!;
      const people = focus.split("\n").filter((line) => line.startsWith("- "));
      expect(people.map((line) => line.split(",")[0])).toEqual(["- Kit (@kit_k)", "- Bob", "- Gleb", "- Quiet", "- Тор"]);
      expect(people[0]).toContain(", asking");
      expect(people[1]).toContain(", replied to");
      expect(people[2]).toContain(", named");
      expect(people[3]).toBe("- Quiet, named: asked not to collect anything about them");
      for (const value of stack) expect(focus).toContain(`${value} (✍ `);
      expect(focus).toContain(`projects: Atlas #1 (0 pts, launched)`);
      expect(focus).toMatch(/with you lately: .*“who knows Rust here\?” → you: “you do, apparently”/);
      expect(focus).toContain("Rust vs Go — Kit argued for Rust.");
      expect(focus).not.toContain("Ancient history");
      expect(focus).not.toContain("Dora");
      // The members list keeps every card whoever asks, so the chat's memory reads the same in every answer.
      expect(block(context, "members")).toMatch(/^- Kit \(@kit_k\) \| stack: /m);
      expect(block(context, "members")).toContain("- Dora (@dora_d) | interest: climbing");
      for (const line of focus.split("\n- ")) expect(line.length).toBeLessThanOrEqual(1800 + 2);
    });

    it("explains a project's rating when the question names the project or asks about the asker's score", async () => {
      const chat = await newChat();
      const kit = await member(chat, "Kit");
      const dora = await member(chat, "Dora");
      const voters = [];
      for (const name of ["Ann", "Ben", "Cid", "Dee", "Eve"]) voters.push(await member(chat, name));
      const nova = await addUserProject(sql, { chatId: chat, name: "Nova", actorUserId: dora.id });
      const orbit = await addUserProject(sql, { chatId: chat, name: "Orbit", actorUserId: kit.id });
      await renameProject(sql, { chatId: chat, projectId: orbit.project.id, name: "Atlas", source: "user", actorUserId: kit.id });
      const relic = await addUserProject(sql, { chatId: chat, name: "Relic", actorUserId: dora.id });
      await updateProject(sql, { chatId: chat, projectId: relic.project.id, status: "abandoned", source: "user", actorUserId: dora.id });
      for (const voter of voters) await sql`INSERT INTO votes (project_id, user_id) VALUES (${nova.project.id}, ${voter.id})`;
      await sql`INSERT INTO votes (project_id, user_id, created_at) VALUES (${orbit.project.id}, ${voters[0]!.id}, now() - interval '5 days')`;
      await sql`INSERT INTO votes (project_id, user_id) VALUES (${relic.project.id}, ${voters[1]!.id})`;
      const signal = (kind: string, impact: number, note: string, daysAgo: number, userId: number) => sql`
        INSERT INTO project_signals (project_id, user_id, kind, impact, note, happened_at)
        VALUES (${orbit.project.id}, ${userId}, ${kind}, ${impact}, ${note}, ${new Date(Date.now() - daysAgo * DAY)})`;
      await signal("usage", 4, "Ann uses it daily", 3, voters[0]!.id);
      await signal("praise", 2, "Ben likes it", 10, voters[1]!.id);
      await signal("milestone", 5, "first 1000 users", 400, kit.id);

      const details = block(await contextFor(asking(chat, dora, "почему у Atlas такой рейтинг?")), "project_details")!;
      expect(details).toMatch(/Atlas \(#atlas\): #2 of 3, 19 rating points; the leader Nova has 25 \(6 more\)\. Status: in progress since \d{1,2} \w{3,4}\./);
      expect(details).toMatch(/^Votes: 1 \(\d{1,2} \w{3,4}(?: \d{4})?\)\.$/m);
      expect(details).toContain("usage 11.2 (impact 4, ");
      expect(details).toContain("praise 3.2 (impact 2, ");
      expect(details).toMatch(/Renamed from Orbit on \d{1,2} \w{3,4}\./);
      expect(details).toMatch(/Milestones of all time: \d{1,2} \w{3,4} \d{4} “first 1000 users” \(counts 0 now\)\./);
      expect(details).not.toMatch(/Ann|Ben|weight|decay|per vote|180|45 days/);

      const own = block(await contextFor(asking(chat, kit, "почему у меня так мало баллов?")), "project_details")!;
      expect(own).toContain("Atlas (#atlas): #2 of 3");
      const abandoned = block(await contextFor(asking(chat, kit, "что с Relic?")), "project_details")!;
      expect(abandoned).toContain("Abandoned: the total is multiplied by 0.3.");
      expect(await contextFor(asking(chat, kit, "как дела у всех?"))).not.toContain("<project_details>");
    });

    it("hands a referee the whole conversation since the last long pause instead of the latest messages", async () => {
      const chat = await newChat();
      const kit = await member(chat, "Kit");
      const bob = await member(chat, "Bob");
      for (let index = 0; index < 5; index += 1) await say(chat, kit, `tabs or spaces, round ${index}`, { at: new Date(Date.now() - 3 * 60 * MINUTE + index * MINUTE) });
      const start = Date.now() - 50 * MINUTE;
      for (let index = 0; index < 40; index += 1) {
        await say(chat, index % 2 ? kit : bob, `${index % 2 ? "Claude" : "Codex"} is better, argument ${index}: ${"so ".repeat(index === 7 ? 200 : 3)}`, { at: new Date(start + index * MINUTE) });
      }
      await botSays(chat, "I'm staying out of this one", { at: new Date(start + 41 * MINUTE) });

      const context = await contextFor(asking(chat, kit, "рассуди нас, кто прав?"));
      expect(context).not.toContain("<recent_messages>");
      const segment = block(context, "current_conversation")!.split("\n");
      expect(segment).toHaveLength(41);
      expect(segment.join("\n")).not.toContain("tabs or spaces");
      expect(segment.at(-1)).toMatch(/\] Waggle: I'm staying out of this one$/);
      expect(Math.max(...segment.map((line) => line.replace(/^\[[^\]]*\] \w+: /, "").length))).toBeLessThanOrEqual(250);

      const plain = await contextFor(asking(chat, kit, "что нового?"));
      expect(block(plain, "recent_messages")!.split("\n")).toHaveLength(30);
    });

    it("quotes what the chronicler has not processed yet before the latest messages, in chunks the next answer repeats byte for byte", async () => {
      const chat = await newChat();
      const kit = await member(chat, "Kit");
      const bob = await member(chat, "Bob");
      const start = Date.now() - 5 * 60 * MINUTE;
      const ids: number[] = [];
      for (let index = 0; index < 100; index += 1) ids.push(await say(chat, index % 2 ? kit : bob, `point ${index}`, { at: new Date(start + index * MINUTE) }));
      await sql`UPDATE messages SET extracted_at = now() WHERE chat_id = ${chat} AND msg_id <= ${ids[9]!}`;
      // A refused message that was edited since waits again, and stays out all the same.
      await sql`INSERT INTO app_state (key, value) VALUES (${`extraction_skipped:${chat}`}, ${sql.json({ msg_ids: [ids[20]!] })})`;
      const options = { timezone: "UTC", model: "claude-opus-5-5", ownerTgIds: [OWNER], recentAnswers: [], insultMotif: "the scrolls are sealed" };

      const parts = await buildReplyContext(sql, asking(chat, kit, "что было утром?"), options);
      expect(parts.map((part) => part.cached)).toEqual([true, false, true, false, false]);
      const context = promptText(parts);
      const earlier = block(context, "earlier_messages")!.split("\n").map((row) => row.replace(/^\[[^\]]*\] \w+: /, ""));
      expect(earlier).toEqual(Array.from({ length: 60 }, (_, index) => `point ${index + 10}`).filter((text) => text !== "point 20"));
      expect(block(context, "recent_messages")!.split("\n")[0]).toMatch(/: point 70$/);
      expect(context.indexOf("</earlier_messages>")).toBeLessThan(context.indexOf("<recent_messages>"));

      for (let index = 100; index < 105; index += 1) await say(chat, bob, `point ${index}`);
      const next = await buildReplyContext(sql, asking(chat, bob, "а что Kit думает?"), options);
      // Another asker, five more messages: the memory and the complete chunks are the same bytes, only the tail moved on.
      expect(next[0]!.text).toBe(parts[0]!.text);
      expect(next.slice(1, 3).map((part) => part.text)).toEqual(parts.slice(1, 3).map((part) => part.text));
      expect(next[3]!.text).toMatch(/: point 74\n$/);

      await sql`UPDATE messages SET extracted_at = now() WHERE chat_id = ${chat}`;
      const afterPass = await buildReplyContext(sql, asking(chat, kit, "что было утром?"), options);
      expect(afterPass.map((part) => part.cached)).toEqual([true, false]);
      expect(promptText(afterPass)).not.toContain("earlier_messages");
    });

    it("keeps out of the window an opted-out member's words and an old message edited since the last pass, and marks forwards", async () => {
      const chat = await newChat();
      const kit = await member(chat, "Kit");
      const quiet = await member(chat, "Quiet");
      await setOptOut(sql, quiet.id, true, chat);
      const start = Date.now() - 8 * 60 * MINUTE;
      const old = await say(chat, kit, "the old roadmap", { at: new Date(start) });
      await sql`UPDATE messages SET extracted_at = now() WHERE chat_id = ${chat} AND msg_id = ${old}`;
      await sql`INSERT INTO extraction_runs (chat_id, finished_at, status, first_msg_id, last_msg_id) VALUES (${chat}, now(), 'done', ${old}, ${old})`;
      await sql`UPDATE messages SET text = 'the old roadmap, rewritten', extracted_at = NULL WHERE chat_id = ${chat} AND msg_id = ${old}`;
      await say(chat, quiet, "nobody needs to remember this", { at: new Date(start + MINUTE) });
      await saveMessage(sql, {
        chatId: chat, msgId: ++nextMsgId, userId: kit.id, sentAt: new Date(start + 2 * MINUTE), text: "Breaking: a framework nobody asked for", replyToMsgId: null,
        isForward: true, forwardSource: "Some Channel", mediaType: null,
      });
      await say(chat, kit, "my own take: skip it", { at: new Date(start + 3 * MINUTE) });
      for (let index = 0; index < 30; index += 1) await say(chat, kit, `later ${index}`, { at: new Date(start + (10 + index) * MINUTE) });

      const earlier = block(await contextFor(asking(chat, kit, "что было утром?")), "earlier_messages")!.split("\n");
      expect(earlier).toHaveLength(2);
      expect(earlier[0]).toMatch(/\] Kit \[forwarded\]: Breaking: a framework nobody asked for$/);
      expect(earlier[1]).toMatch(/\] Kit: my own take: skip it$/);
    });

    it("leaves out the oldest waiting messages a hundred at a time when too many wait, and says so", async () => {
      const chat = await newChat();
      const kit = await member(chat, "Kit");
      const start = Date.now() - 10 * 60 * MINUTE;
      for (let index = 0; index < 360; index += 1) await say(chat, kit, `line ${index}`, { at: new Date(start + index * MINUTE) });
      const context = await contextFor(asking(chat, kit, "что нового?"));
      const earlier = block(context, "earlier_messages")!.split("\n");
      // 330 wait before the latest 30: the oldest hundred step aside, so the window shifts once in a hundred messages.
      expect(earlier[0]).toBe("(older messages since the chronicler's last pass are left out)");
      expect(earlier[1]).toMatch(/: line 100$/);
      expect(earlier.at(-1)).toMatch(/: line 329$/);
      expect(earlier).toHaveLength(231);
    });
  });

  describe("the bot in a group", () => {
    const calls: { method: string; payload: Record<string, any> }[] = [];
    let updateId = 1;
    /** Telegram as the bot sees it: replies carry the chat's type, a date, and the text without the HTML markup. */
    const telegram = async (_prev: unknown, method: string, payload: Record<string, any>) => {
      calls.push({ method, payload });
      if (method === "getChatMember") return { ok: true, result: { status: "member", user: { id: payload.user_id, is_bot: false, first_name: "X" } } };
      if (method === "sendMessage" || method === "editMessageText") {
        const chat = payload.chat_id < 0 ? { id: payload.chat_id, type: "supergroup", title: "Hive" } : { id: payload.chat_id, type: "private", first_name: "X" };
        const text = payload.parse_mode === "HTML" ? String(payload.text).replace(/<[^>]*>/g, "") : String(payload.text);
        const messageId = method === "editMessageText" ? payload.message_id : ++nextMsgId;
        return { ok: true, result: { message_id: messageId, date: now(), chat, text, ...(method === "editMessageText" ? { edit_date: now() } : {}) } };
      }
      return { ok: true, result: true };
    };
    const config = {
      BOT_TOKEN: TOKEN, ADMIN_TG_IDS: [OWNER], DATABASE_URL: DATABASE_URL!, BOT_MODE: "polling", PORT: 0, EXTRACTION_MODEL: "x", EXTRACTION_INTERVAL_HOURS: 6, EXTRACTION_PASS_MESSAGES: 200, EXTRACTION_MIN_GAP_MINUTES: 60,
      MESSAGE_RETENTION_DAYS: 7, DISPLAY_TIMEZONE: "UTC", MONTHLY_LLM_BUDGET_USD: 60, CHAT_MONTHLY_BUDGET_USD: 20, WEB_DIST_DIR: "web/dist", DEV_BROWSER_LOGIN: false,
      DEV_LOGIN_AS: "", REPLY_MODEL: "claude-haiku-5-5", REPLIES_MONTHLY_BUDGET_USD: 10, REPLY_PREMIUM_MODEL: "claude-opus-5-5", REPLY_PREMIUM_PER_MEMBER_PER_HOUR: 10,
      REPLY_PREMIUM_MONTHLY_BUDGET_USD: 0,
    } as unknown as Config;
    const prompts: string[] = [];
    let answer = "Bob writes Rust 🐝";
    const claude = {
      messages: {
        create: async (params: { messages: { content: { text: string }[] }[] }) => {
          prompts.push(params.messages[0]!.content.map((block) => block.text).join(""));
          return { stop_reason: "end_turn", content: [{ type: "text", text: answer }], usage: { input_tokens: 1000, output_tokens: 50 } };
        },
      },
    } as unknown as Anthropic;
    const made = () => {
      const created = createBot({ sql, config, anthropic: claude, answerLimits: { memberGapMs: 0 }, transport: telegram as never });
      created.bot.botInfo = me as typeof created.bot.botInfo;
      return created;
    };
    let bot: ReturnType<typeof made>["bot"];
    let assistant: ReturnType<typeof made>["assistant"];
    let chat: number;
    const tg = (id: number, first_name: string, username?: string) => ({ id, is_bot: false, first_name, ...(username ? { username } : {}) });
    const owner = tg(OWNER, "Maestro", "maestro_owner");
    const alice = tg(9851, "Alice", "alice_a");
    const bob = tg(9852, "Bob", "bob_b");
    const gleb = tg(9853, "Gleb", "gleb_t");
    const group = () => ({ id: chat, type: "supergroup", title: "Hive" });
    const command = (text: string) => (text.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] } : {});
    const inGroup = (from: ReturnType<typeof tg>, text: string, extra: Record<string, unknown> = {}) => ({
      update_id: updateId++,
      message: { message_id: ++nextMsgId, date: now(), chat: group(), from, text, ...command(text), ...extra },
    });
    const inDm = (from: ReturnType<typeof tg>, text: string) => ({
      update_id: updateId++,
      message: { message_id: ++nextMsgId, date: now(), chat: { id: from.id, type: "private", first_name: from.first_name }, from, text, ...command(text) },
    });
    const MENTION = "@waggle_test_bot";
    const ask = (from: ReturnType<typeof tg>, question: string, extra: Record<string, unknown> = {}) =>
      inGroup(from, `${MENTION} ${question}`, { entities: [{ type: "mention", offset: 0, length: MENTION.length }], ...extra });
    const lastSent = () => String(calls.filter((call) => call.method === "sendMessage").at(-1)?.payload.text ?? "").replace(/<[^>]*>/g, "");
    const stored = (msgId: number) =>
      sql<{ user_id: number | null; from_bot: boolean; text: string; reply_to_msg_id: number | null; sent_at: Date; extracted_at: Date | null }[]>`
        SELECT user_id, from_bot, text, reply_to_msg_id, sent_at, extracted_at FROM messages WHERE chat_id = ${chat} AND msg_id = ${msgId}`;

    beforeAll(async () => {
      chat = await newChat("Bot hive");
      for (const person of [owner, alice, bob, gleb]) await resolveUser(sql, person, [OWNER], chat);
      ({ bot, assistant } = made());
    });

    beforeEach(() => {
      calls.length = 0;
    });

    it("stores what it posts in an approved group, through the same transport that sends it", async () => {
      const question = ask(alice, "who writes Rust here?");
      await bot.handleUpdate(question as never);
      await assistant!.idle();
      const sent = calls.find((call) => call.method === "sendMessage" && call.payload.chat_id === chat)!;
      const [reply] = await sql<{ msg_id: number }[]>`SELECT msg_id FROM messages WHERE chat_id = ${chat} AND from_bot ORDER BY msg_id DESC LIMIT 1`;
      const [row] = await stored(reply!.msg_id);
      expect(sent.payload.text).toBe("Bob writes Rust 🐝");
      expect(row).toMatchObject({ user_id: null, from_bot: true, text: "Bob writes Rust 🐝", reply_to_msg_id: question.message.message_id, extracted_at: null });
      expect(Math.abs(row!.sent_at.getTime() - Date.now())).toBeLessThan(5 * MINUTE);

      // A command's answer is stored as plain text, and editing that message updates it.
      const people = inGroup(alice, "/people");
      await bot.handleUpdate(people as never);
      const [list] = await sql<{ msg_id: number; text: string; reply_to_msg_id: number }[]>`
        SELECT msg_id, text, reply_to_msg_id FROM messages WHERE chat_id = ${chat} AND from_bot ORDER BY msg_id DESC LIMIT 1`;
      expect(list!.text).toContain("Chat members");
      expect(list!.text).not.toContain("<b>");
      expect(list!.reply_to_msg_id).toBe(people.message.message_id);
      const [aliceUser] = await sql<{ id: number }[]>`SELECT id FROM users WHERE tg_id = ${alice.id}`;
      await bot.handleUpdate({
        update_id: updateId++,
        callback_query: { id: "cq", from: alice, chat_instance: "ci", data: `u:${aliceUser!.id}`, message: { message_id: list!.msg_id, date: now(), chat: group(), from: me, text: list!.text } },
      } as never);
      expect((await stored(list!.msg_id))[0]!.text).toMatch(/^Alice @alice_a/);

      // Nothing from a DM, nothing from a chat that is not approved.
      const before = (await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM messages WHERE from_bot`)[0]!.count;
      await bot.handleUpdate(inDm(alice, "/help") as never);
      nextChat -= 1;
      const pending = nextChat;
      await registerChat(sql, pending, "Pending", null);
      await bot.api.sendMessage(pending, "waiting for approval");
      expect((await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM messages WHERE from_bot`)[0]!.count).toBe(before);
    });

    it("shows the next question the conversation it continues, without repeating its answer from memory", async () => {
      const [last] = await sql<{ msg_id: number; text: string }[]>`
        SELECT msg_id, text FROM messages WHERE chat_id = ${chat} AND from_bot AND text = 'Bob writes Rust 🐝' ORDER BY msg_id DESC LIMIT 1`;
      prompts.length = 0;
      answer = "and you read it";
      await bot.handleUpdate(inGroup(bob, "guilty, and what do you write?", { reply_to_message: { message_id: last!.msg_id, date: now(), chat: group(), from: me, text: last!.text } }) as never);
      await assistant!.idle();
      expect(prompts).toHaveLength(1);
      const thread = block(prompts[0]!, "thread")!.split("\n");
      expect(thread[0]).toMatch(/\] Alice: @waggle_test_bot who writes Rust here\?$/);
      expect(thread[1]).toMatch(/\] Waggle ↩\d+: Bob writes Rust 🐝$/);
      expect(prompts[0]).not.toContain("<your_message_they_reply_to>");
      // The answer is among the recent messages already, so the list of answers kept in memory leaves it out.
      expect(block(prompts[0]!, "recent_messages")).toContain("Waggle ↩");
      expect(prompts[0]).not.toContain("<your_recent_answers>");
      expect(prompts[0]).toContain("this answer is written by claude-haiku-5-5");
    });

    it("leaves its own messages out of /catchup and out of the counts in /botstatus", async () => {
      const [aliceUser] = await sql<{ id: number }[]>`SELECT id FROM users WHERE tg_id = ${alice.id}`;
      const [answerToAlice] = await sql<{ msg_id: number }[]>`
        SELECT a.msg_id FROM messages a JOIN messages q ON q.chat_id = a.chat_id AND q.msg_id = a.reply_to_msg_id
        WHERE a.chat_id = ${chat} AND a.from_bot AND q.user_id = ${aliceUser!.id} LIMIT 1`;
      expect(answerToAlice).toBeDefined();
      const person = (await getPerson(sql, chat, aliceUser!.id))!;
      const catchup = await catchupFor(sql, chat, person, 24);
      const [counts] = await sql<{ people: number; pending: number }[]>`
        SELECT count(*) FILTER (WHERE sent_at > now() - interval '24 hours')::int AS people, count(*) FILTER (WHERE extracted_at IS NULL)::int AS pending
        FROM messages WHERE chat_id = ${chat} AND NOT from_bot`;
      expect(catchup.totalMessages).toBe(counts!.people);
      expect(catchup.unprocessed.count).toBe(counts!.people);
      expect(catchup.mentions.map((mention) => mention.msg_id)).not.toContain(answerToAlice!.msg_id);

      // /botstatus lists every approved chat; the others step aside so this one's lines fit into one message.
      const others = await sql<{ id: number }[]>`UPDATE chats SET status = 'left' WHERE id <> ${chat} AND status = 'approved' RETURNING id`;
      try {
        await bot.handleUpdate(inDm(owner, "/botstatus") as never);
        expect(lastSent()).toContain(`Bot hive\nMessages: ${counts!.pending}, waiting for the chronicler: ${counts!.pending}, next pass `);
      } finally {
        await sql`UPDATE chats SET status = 'approved' WHERE id = ANY(${others.map((row) => row.id)})`;
      }
    });

    it("lets an owner name members, a member name themselves, a project's authors name it, and only them", async () => {
      const [aliceUser] = await sql<{ id: number }[]>`SELECT id FROM users WHERE tg_id = ${alice.id}`;
      await addUserProject(sql, { chatId: chat, name: "Atlas", actorUserId: aliceUser!.id });
      const aliases = async () =>
        (await sql<{ alias: string; source: string; user_id: number | null; project_id: number | null }[]>`
          SELECT alias, source, user_id, project_id FROM aliases WHERE chat_id = ${chat} ORDER BY id`).map((row) => `${row.alias}:${row.source}`);

      await bot.handleUpdate(inGroup(owner, "/alias @gleb_t Громовержец") as never);
      expect(lastSent()).toContain("“Громовержец” means Gleb now");
      await bot.handleUpdate(inGroup(alice, "/alias @gleb_t Lightning") as never);
      expect(lastSent()).toContain("Only a bot owner names other people");
      await bot.handleUpdate(inGroup(alice, "/alias me Алиска") as never);
      expect(lastSent()).toContain("“Алиска” means you now");
      await bot.handleUpdate(inGroup(alice, "/alias @alice_a Ali") as never);
      await bot.handleUpdate(inGroup(alice, "/alias #atlas Атлас") as never);
      expect(lastSent()).toContain("“Атлас” means the project Atlas now");
      await bot.handleUpdate(inGroup(bob, "/alias #atlas Atlantis") as never);
      expect(lastSent()).toContain("Only the authors of Atlas or a bot owner can name it");
      await bot.handleUpdate(inGroup(bob, "/alias me Депрессия") as never);
      expect(lastSent()).toContain("never keep");
      await bot.handleUpdate(inGroup(bob, "/alias Bob") as never);
      expect(lastSent()).toContain("/alias me Name");
      // In a DM the alias goes to the chat the owner works with.
      await sql`UPDATE users SET current_chat_id = ${chat} WHERE tg_id = ${OWNER}`;
      await bot.handleUpdate(inDm(owner, "/alias @gleb_t Thunder") as never);
      expect(lastSent()).toContain("“Thunder” means Gleb now");
      expect(await aliases()).toEqual(["Громовержец:owner", "Алиска:person", "Ali:person", "Атлас:person", "Thunder:owner"]);

      await bot.handleUpdate(inGroup(bob, "/aliases") as never);
      expect(lastSent()).toContain("Gleb @gleb_t — Громовержец (set by an owner), Thunder (set by an owner)");
      expect(lastSent()).toContain("Atlas #atlas — Атлас (set by an author)");

      await bot.handleUpdate(inGroup(alice, "/unalias Громовержец") as never);
      expect(lastSent()).toContain("Only a bot owner or whoever");
      await bot.handleUpdate(inGroup(gleb, "/unalias громовержец") as never);
      expect(lastSent()).toContain("Removed “громовержец” for Gleb");
      await bot.handleUpdate(inGroup(owner, "/unalias Ali") as never);
      expect(await aliases()).toEqual(["Алиска:person", "Атлас:person", "Thunder:owner"]);

      await setOptOut(sql, aliceUser!.id, true, chat);
      expect(await aliases()).toEqual(["Атлас:person", "Thunder:owner"]);
      await bot.handleUpdate(inGroup(alice, "/alias me Алиска") as never);
      expect(lastSent()).toContain("You asked me not to collect anything about you here");
      await setOptOut(sql, aliceUser!.id, false, chat);
    });
  });

  describe("privacy and moves", () => {
    it("blanks the bot's answers to a person who asks to forget their messages, and nobody else's", async () => {
      const chat = await newChat();
      const kit = await member(chat, "Kit");
      const dora = await member(chat, "Dora");
      const kitAsks = await say(chat, kit, "what do you know about me?");
      const toKit = await botSays(chat, "that you ask a lot", { replyTo: kitAsks });
      const doraAsks = await say(chat, dora, "and about me?");
      const toDora = await botSays(chat, "that you climb", { replyTo: doraAsks });
      await addAlias(sql, { chatId: chat, target: { userId: kit.id }, alias: "Котик", source: "person" });
      await forgetUser(sql, kit.id, { chatId: chat, messages: true });
      const texts = await sql<{ msg_id: number; text: string }[]>`SELECT msg_id, text FROM messages WHERE chat_id = ${chat} ORDER BY msg_id`;
      expect(texts).toEqual([
        { msg_id: kitAsks, text: "" },
        { msg_id: toKit, text: "" },
        { msg_id: doraAsks, text: "and about me?" },
        { msg_id: toDora, text: "that you climb" },
      ]);
      expect(await sql`SELECT 1 FROM aliases WHERE user_id = ${kit.id}`).toHaveLength(0);
    });

    it("moves aliases with a linked card, a supergroup upgrade, an attached import and a merged duplicate", async () => {
      const chat = await newChat();
      const account = await member(chat, "Maestro");
      const [card] = await sql<{ id: number }[]>`INSERT INTO users (display_name) VALUES ('Maestro from the export') RETURNING id`;
      await sql`INSERT INTO members (chat_id, user_id) VALUES (${chat}, ${card!.id})`;
      await addAlias(sql, { chatId: chat, target: { userId: card!.id }, alias: "Маэстро", source: "owner" });
      await addAlias(sql, { chatId: chat, target: { userId: card!.id }, alias: "Шеф", source: "owner" });
      await addAlias(sql, { chatId: chat, target: { userId: account.id }, alias: "шеф", source: "person" });
      await mergeSeedUser(sql, card!.id, account.id, account.id);
      const of = async (where: number) => (await sql<{ alias: string }[]>`SELECT alias FROM aliases WHERE chat_id = ${where} ORDER BY alias`).map((row) => row.alias);
      expect(await of(chat)).toEqual(["Маэстро", "шеф"]);

      const lumen = await addUserProject(sql, { chatId: chat, name: "Lumen", actorUserId: account.id });
      const copy = await addUserProject(sql, { chatId: chat, name: "Lumen app", actorUserId: account.id });
      await addAlias(sql, { chatId: chat, target: { projectId: copy.project.id }, alias: "Люмен", source: "person" });
      await mergeProjects(sql, chat, lumen.project.slug, [copy.project.slug]);
      expect((await sql<{ project_id: number }[]>`SELECT project_id FROM aliases WHERE alias = 'Люмен'`)[0]!.project_id).toBe(lumen.project.id);

      const upgraded = chat - 900_000;
      await migrateChat(sql, chat, upgraded);
      expect(await of(chat)).toEqual([]);
      expect(await of(upgraded)).toEqual(["Люмен", "Маэстро", "шеф"]);

      const imported = await sql<{ id: number }[]>`INSERT INTO projects (chat_id, slug, name) VALUES (${LEGACY_CHAT_ID}, 'lumen', 'Lumen') RETURNING id`;
      await sql`INSERT INTO aliases (chat_id, project_id, alias, alias_norm, source) VALUES (${LEGACY_CHAT_ID}, ${imported[0]!.id}, 'Lumen classic', 'lumen classic', 'owner')`;
      await attachLegacyData(sql, upgraded);
      expect((await sql<{ chat_id: number; project_id: number }[]>`SELECT chat_id, project_id FROM aliases WHERE alias = 'Lumen classic'`)[0]).toEqual({ chat_id: upgraded, project_id: lumen.project.id });
    });
  });

  describe("the chronicler and the bot's lines", () => {
    /** The first call answers with `result`; the second one, for the private notes, finds none and is not among the prompts. */
    function fakeModel(result: ExtractionResult) {
      const prompts: string[] = [];
      const client = {
        messages: {
          stream(params: { system: string; messages: { content: string }[] }) {
            const notesCall = params.system === NOTES_SYSTEM_PROMPT;
            if (!notesCall) prompts.push(params.messages[0]!.content);
            const answer = notesCall ? { notes: [], aliases: [] } : result;
            const message = { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(answer) }], usage: { input_tokens: 10_000, output_tokens: 1_000 } };
            return { currentMessage: message, finalMessage: async () => message };
          },
        },
      } as unknown as Anthropic;
      return { client, prompts };
    }
    const EMPTY: ExtractionResult = { topics: [], facts_add: [], facts_update: [], projects: [], project_renames: [], project_signals: [] };
    const pass = (chatId: number, client: Anthropic) =>
      runExtractionPass({ sql, anthropic: client, chatId, chatBudgetUsd: 50, config: { EXTRACTION_MODEL: "claude-sonnet-5-5", MONTHLY_LLM_BUDGET_USD: 500 } });

    it("takes what waited when the pass began, and leaves what arrives meanwhile for the next one", async () => {
      const chat = await newChat();
      const kit = await member(chat, "Kit");
      await say(chat, kit, "shipped the importer today, finally", { at: new Date(Date.now() - 7 * 60 * MINUTE) });
      let lateId = 0;
      const prompts: string[] = [];
      const client = {
        messages: {
          stream(params: { system: string; messages: { content: string }[] }) {
            const notesCall = params.system === NOTES_SYSTEM_PROMPT;
            if (!notesCall) prompts.push(params.messages[0]!.content);
            const message = { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(notesCall ? { notes: [], aliases: [] } : EMPTY) }], usage: { input_tokens: 10_000, output_tokens: 1_000 } };
            return {
              currentMessage: message,
              finalMessage: async () => {
                if (!notesCall && !lateId) lateId = await say(chat, kit, "and the exporter is next on my list");
                return message;
              },
            };
          },
        },
      } as unknown as Anthropic;
      const result = await pass(chat, client);
      expect(prompts).toHaveLength(1);
      expect(result.messages).toBe(1);
      expect(await sql`SELECT msg_id FROM messages WHERE chat_id = ${chat} AND extracted_at IS NULL`).toEqual([{ msg_id: lateId }]);
    });

    it("does not count a pass a stop cut short as a failure that delays the next one", async () => {
      const chat = await newChat();
      await sql`INSERT INTO extraction_runs (chat_id, started_at, finished_at, status) VALUES (${chat}, now() - interval '3 hours', now() - interval '3 hours', 'done')`;
      await sql`INSERT INTO extraction_runs (chat_id, started_at, finished_at, status, error) VALUES (${chat}, now() - interval '10 minutes', now(), 'failed', ${INTERRUPTED_PASS_ERROR})`;
      expect(await nextExtractionRetryAt(sql, chat)).toBeNull();
      const [failed] = await sql<{ started_at: Date }[]>`
        INSERT INTO extraction_runs (chat_id, started_at, finished_at, status, error) VALUES (${chat}, now() - interval '20 minutes', now(), 'failed', 'the model went away') RETURNING started_at`;
      await sql`INSERT INTO extraction_runs (chat_id, started_at, finished_at, status, error) VALUES (${chat}, now() - interval '5 minutes', now(), 'failed', ${INTERRUPTED_PASS_ERROR})`;
      expect(await nextExtractionRetryAt(sql, chat)).toEqual(new Date(failed!.started_at.getTime() + 60 * MINUTE));
    });

    it("sees the bot's lines labelled, and takes nothing about people from them", async () => {
      const chat = await newChat();
      const kit = await member(chat, "Kit");
      const asks = await say(chat, kit, "Кто здесь пишет на Rust? Я вот пишу на нём каждый день, ищу тестировщиков для своего бота", { at: new Date(Date.now() - 7 * 60 * MINUTE) });
      const reply = await botSays(chat, "Kit also writes Go and Haskell, everyone knows that", { replyTo: asks, at: new Date(Date.now() - 7 * 60 * MINUTE + MINUTE) });
      const { client, prompts } = fakeModel({
        ...EMPTY,
        topics: [
          { title: "The bot talks to itself", summary: "Only the bot's line.", kind: "discussion", importance: 2, project: null, msg_ids: [reply] },
          { title: "Kit and Rust", summary: "Kit writes Rust every day.", kind: "discussion", importance: 3, project: null, msg_ids: [asks, reply] },
        ],
        facts_add: [
          { person: `u${kit.id}`, kind: "stack", value: "Rust", confidence: 0.95, source_msg_ids: [asks] },
          { person: `u${kit.id}`, kind: "stack", value: "Go", confidence: 0.95, source_msg_ids: [reply] },
          { person: `u${kit.id}`, kind: "looking_for", value: "тестировщики для бота", confidence: 0.9, source_msg_ids: [asks] },
        ],
      });
      await pass(chat, client);
      expect(prompts[0]).toMatch(new RegExp(`\\[${reply} \\d{2}:\\d{2}\\] Waggle \\(bot\\) ↩${asks}: Kit also writes Go and Haskell`));
      const facts = await sql<{ kind: string; value: string }[]>`SELECT kind, value FROM facts WHERE chat_id = ${chat} ORDER BY id`;
      expect(facts).toEqual([
        { kind: "stack", value: "Rust" },
        { kind: "looking_for", value: "тестировщики для бота" },
      ]);
      const topics = await sql<{ title: string; heat: number; user_ids: number[] }[]>`SELECT title, heat, user_ids FROM chronicle WHERE chat_id = ${chat}`;
      expect(topics).toEqual([{ title: "Kit and Rust", heat: 2, user_ids: [kit.id] }]);
    });

    it("makes no call for the bot's lines alone, and does not let them decide the chat's language", async () => {
      const quiet = await newChat();
      await botSays(quiet, "🐝 Hi! Ask me about the people here, their projects or the rating.", { at: new Date(Date.now() - 7 * 60 * MINUTE) });
      const idle = fakeModel(EMPTY);
      await pass(quiet, idle.client);
      expect(idle.prompts).toHaveLength(0);
      expect(await sql`SELECT 1 FROM messages WHERE chat_id = ${quiet} AND extracted_at IS NULL`).toHaveLength(0);

      const russian = await newChat();
      const anna = await member(russian, "Anna");
      await say(russian, anna, "Выкатила новую версию трекера, теперь он синхронизируется между устройствами", { at: new Date(Date.now() - 7 * 60 * MINUTE) });
      for (let index = 0; index < 6; index += 1) {
        await botSays(russian, `Chat members (12). Tap a name to open their card. Project rating: top, active and new projects, page ${index}`, { at: new Date(Date.now() - 6 * 60 * MINUTE) });
      }
      const measured = fakeModel(EMPTY);
      await pass(russian, measured.client);
      expect(measured.prompts[0]!.startsWith("<chat_language>Russian</chat_language>")).toBe(true);
    });
  });

  it("applies the memory migrations on a fresh database", async () => {
    expect((await sql<{ name: string }[]>`SELECT name FROM schema_migrations ORDER BY name`).map((row) => row.name)).toEqual(expect.arrayContaining(["001_init.sql", "002_chronicle_pause.sql", "003_memory.sql", "004_themes.sql"]));
    const [debate] = await sql<{ kind: string }[]>`
      INSERT INTO chronicle (chat_id, run_id, period_from, period_to, title, summary, kind)
      VALUES (-1, 0, now(), now(), 'Tabs vs spaces', 'Nobody gave in.', 'debate') RETURNING kind`;
    expect(debate).toEqual({ kind: "debate" });
    expect(await sql`SELECT 1 FROM information_schema.columns WHERE table_name = 'chronicle' AND column_name = 'temperature'`).toHaveLength(0);
    await expect(sql`INSERT INTO aliases (chat_id, alias, alias_norm, source) VALUES (-1, 'x', 'x', 'owner')`).rejects.toThrow();
    const [note] = await sql<{ kind: string; status: string; due_at: Date }[]>`
      INSERT INTO notes (chat_id, kind, value, value_norm, status, due_at, confidence)
      VALUES (-1, 'prediction', 'chats will be gone', 'chats will be gone', 'wrong', '2027-05-01', 0.9) RETURNING kind, status, due_at`;
    expect(note).toEqual({ kind: "prediction", status: "wrong", due_at: new Date("2027-05-01T00:00:00Z") });
    for (const kind of ["bout", "bait", "about_bot"]) await sql`INSERT INTO notes (chat_id, kind, value, value_norm, confidence) VALUES (-1, ${kind}, ${kind}, ${kind}, 0.9)`;
    await expect(sql`INSERT INTO notes (chat_id, kind, value, value_norm, confidence) VALUES (-1, 'rumour', 'x', 'x', 0.9)`).rejects.toThrow();
    await expect(sql`INSERT INTO notes (chat_id, kind, value, value_norm, status, confidence) VALUES (-1, 'claim', 'y', 'y', 'maybe', 0.9)`).rejects.toThrow();
    expect((await sql<{ interjections: boolean }[]>`SELECT interjections FROM chats LIMIT 1`)[0]!.interjections).toBe(true);
  });
});
