import type Anthropic from "@anthropic-ai/sdk";
import { GrammyError, type Api, type Bot } from "grammy";
import type { Message, UserFromGetMe } from "grammy/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BotContext } from "../src/bot/kit.js";
import {
  chatReminderText,
  dueLabel,
  lateBy,
  privateReminderText,
  registerReminders,
  REMIND_CUE,
  reminderPrompt,
  ReminderReadingSchema,
  reminderStandsIn,
  writtenWhen,
  type ReminderReading,
} from "../src/bot/reminders.js";
import { createSelfEdits, type SelfEditResult } from "../src/bot/self-edits.js";
import { migrateChat } from "../src/core/chat-migration.js";
import { registerChat, setChatStatus } from "../src/core/chats.js";
import { createSql, migrate, type Queryable, type Sql } from "../src/core/db.js";
import { mergeSeedUser } from "../src/core/merge.js";
import { cancelOwnReminder, clearFinishedReminders, ownPendingReminders, waitingReminders, type MemberReminder } from "../src/core/member-reminders.js";
import { saveBotMessage, saveMessage } from "../src/core/messages.js";
import { asSubject, subjectOf } from "../src/core/own-card.js";
import { maskPersonalData, unmaskFrom } from "../src/core/privacy.js";
import { addToDate, calendarDays, dueAt, isoDate, localInstant, localStamp, wallClock, type ReminderUnit, type ReminderWhen } from "../src/core/reminders.js";
import { forgetUser, resolveUser, setOptOut, type User } from "../src/core/users.js";
import { isoDayIn } from "../src/core/zones.js";
import { batchDataFor } from "../src/worker/batch.js";
import { deliverDueReminders, MAX_ATTEMPTS } from "../src/worker/member-reminders.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const OWNER = 9800;
/** Zones whose rules do not move: Warsaw keeps the EU's summer time, Jakarta has none. */
const WARSAW = "Europe/Warsaw";
const JAKARTA = "Asia/Jakarta";

/** A message as its reader sees it: HTML tags gone, entities read. */
const shown = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
const span = (amount: number, unit: ReminderUnit): ReminderWhen => ({ in: [{ amount, unit }], date: null, time: null });
const on = (date: string | null, time: string | null = null): ReminderWhen => ({ in: null, date, time });
/** The due instant as ISO text, or why there is none; `from` is when the words saying when were written. */
function due(when: ReminderWhen, now: string, zone = WARSAW, from?: Date): string {
  const result = dueAt(when, new Date(now), zone, from);
  return result.ok ? result.at.toISOString() : result.problem;
}

describe("when a reminder is due", () => {
  it("counts minutes and hours exactly, and longer spans on the member's calendar at the same local time", () => {
    // 13:00 in Warsaw the day before the clocks go forward: a day on is 13:00 again, 23 hours later; 24 hours on is 14:00.
    expect(due(span(1, "days"), "2027-03-27T12:00:00Z")).toBe("2027-03-28T11:00:00.000Z");
    expect(due(span(24, "hours"), "2027-03-27T12:00:00Z")).toBe("2027-03-28T12:00:00.000Z");
    expect(due(span(90, "minutes"), "2026-11-12T10:00:00Z")).toBe("2026-11-12T11:30:00.000Z");
    expect(due(span(2, "weeks"), "2026-11-12T10:00:00Z")).toBe("2026-11-26T10:00:00.000Z");
    // A month on across the change to summer time is still 10 o'clock: 10:00 CET, then 10:00 CEST.
    expect(due(span(1, "months"), "2027-03-10T09:00:00Z")).toBe("2027-04-10T08:00:00.000Z");
  });

  it("keeps the day of the month where the month has it, and takes its last day where it has not", () => {
    expect(due(span(1, "months"), "2027-01-31T09:00:00Z")).toBe("2027-02-28T09:00:00.000Z");
    expect(due(span(1, "months"), "2028-01-31T09:00:00Z")).toBe("2028-02-29T09:00:00.000Z");
    expect(due(span(2, "months"), "2026-12-31T09:00:00Z")).toBe("2027-02-28T09:00:00.000Z");
    expect(due(span(1, "years"), "2028-02-29T09:00:00Z")).toBe("2029-02-28T09:00:00.000Z");
    expect(addToDate({ year: 2027, month: 3, day: 31 }, 1, "months")).toEqual({ year: 2027, month: 4, day: 30 });
    expect(addToDate({ year: 2026, month: 11, day: 30 }, 14, "months")).toEqual({ year: 2028, month: 1, day: 30 });
  });

  it("puts a date at its time or at 10:00, a span with a time on the day it leads to, and a time alone today or tomorrow", () => {
    expect(due(on("2027-01-01"), "2026-11-12T10:00:00Z")).toBe("2027-01-01T09:00:00.000Z");
    expect(due(on("2027-01-01", "18:30"), "2026-11-12T10:00:00Z")).toBe("2027-01-01T17:30:00.000Z");
    expect(due({ in: [{ amount: 2, unit: "days" }], date: null, time: "10:00" }, "2026-11-12T20:00:00Z")).toBe("2026-11-14T09:00:00.000Z");
    // 11:00 in Warsaw: 18:00 is still ahead today, 09:00 has gone, so it is tomorrow's.
    expect(due(on(null, "18:00"), "2026-11-12T10:00:00Z")).toBe("2026-11-12T17:00:00.000Z");
    expect(due(on(null, "09:00"), "2026-11-12T10:00:00Z")).toBe("2026-11-13T08:00:00.000Z");
    // The member's own clock decides: 08:00 in Jakarta, which keeps no summer time.
    expect(due(on("2026-12-01", "08:00"), "2026-11-12T10:00:00Z", JAKARTA)).toBe("2026-12-01T01:00:00.000Z");
    expect(due(on(null, "18:00"), "2026-11-12T10:00:00Z", JAKARTA)).toBe("2026-11-12T11:00:00.000Z");
  });

  it("moves a local time the clocks skip on by the jump, and takes the first of one they pass twice (Europe/Warsaw)", () => {
    // 28 March 2027: from 02:00 straight to 03:00, so 02:30 is 03:30 summer time.
    expect(localInstant({ year: 2027, month: 3, day: 28 }, { hour: 2, minute: 30 }, WARSAW).toISOString()).toBe("2027-03-28T01:30:00.000Z");
    expect(due(on("2027-03-28", "02:30"), "2027-03-20T10:00:00Z")).toBe("2027-03-28T01:30:00.000Z");
    expect(due(span(1, "days"), "2027-03-27T01:30:00Z")).toBe("2027-03-28T01:30:00.000Z");
    // 25 October 2026: back from 03:00 to 02:00, so 02:30 comes twice; the first is still summer time.
    expect(due(on("2026-10-25", "02:30"), "2026-10-20T10:00:00Z")).toBe("2026-10-25T00:30:00.000Z");
    expect(due(on("2026-10-25", "03:30"), "2026-10-20T10:00:00Z")).toBe("2026-10-25T02:30:00.000Z");
  });

  it("takes a span in parts and an offset before a moment, on the calendar too, so the model never counts", () => {
    // «за 2 дня до 1 марта» in a leap year: 28 February, at 10:00.
    expect(due({ ...on("2028-03-01"), before: [{ amount: 2, unit: "days" }] }, "2028-01-10T10:00:00Z")).toBe("2028-02-28T09:00:00.000Z");
    // «за час до созвона в 15:00», asked at 11:00: 14:00 today.
    expect(due({ ...on(null, "15:00"), before: [{ amount: 1, unit: "hours" }] }, "2026-11-12T10:00:00Z")).toBe("2026-11-12T13:00:00.000Z");
    // «за месяц до 31 марта»: the last day of February, at the same o'clock across the change to summer time.
    expect(due({ ...on("2027-03-31", "12:00"), before: [{ amount: 1, unit: "months" }] }, "2026-11-12T10:00:00Z")).toBe("2027-02-28T11:00:00.000Z");
    // «через месяц и неделю» from 25 January: a month on first, then a week, whatever order the parts come in.
    expect(due({ in: [{ amount: 1, unit: "weeks" }, { amount: 1, unit: "months" }], date: null, time: null }, "2027-01-25T09:00:00Z")).toBe("2027-03-04T09:00:00.000Z");
    // «через день и 3 часа» across the change to summer time: the day on the calendar, the hours exactly.
    expect(due({ in: [{ amount: 1, unit: "days" }, { amount: 3, unit: "hours" }], date: null, time: null }, "2027-03-27T12:00:00Z")).toBe("2027-03-28T14:00:00.000Z");
    // An offset with nothing to count back from says nothing about when; one that leads before now is past.
    expect(due({ ...on(null), before: [{ amount: 1, unit: "days" }] }, "2026-11-12T10:00:00Z")).toBe("no_time");
    expect(due({ ...on("2026-11-13", "10:00"), before: [{ amount: 2, unit: "days" }] }, "2026-11-12T10:00:00Z")).toBe("past");
    expect(due({ ...on("2027-01-01"), before: [{ amount: 0.5, unit: "days" }] }, "2026-11-12T10:00:00Z")).toBe("bad_time");
  });

  it("asks for the hour of a day, or a part of one, that is under way rather than guess it, and moves one that is over to the next day", () => {
    // 15:00 in Warsaw: «сегодня» with no hour; 20:00: «вечером» and «сегодня вечером».
    expect(due(on("2026-11-12"), "2026-11-12T14:00:00Z")).toBe("which_hour");
    expect(due({ ...on(null, "19:00"), words: "вечером" }, "2026-11-12T19:00:00Z")).toBe("which_hour");
    expect(due({ ...on("2026-11-12", "19:00"), words: "сегодня вечером" }, "2026-11-12T19:00:00Z")).toBe("which_hour");
    // Still ahead, it stands; over for the day, «утром» is tomorrow's, and «сегодня утром» has passed; an hour in digits is never a guess.
    expect(due(on("2026-11-12"), "2026-11-12T08:00:00Z")).toBe("2026-11-12T09:00:00.000Z");
    expect(due({ ...on(null, "19:00"), words: "вечером" }, "2026-11-12T15:00:00Z")).toBe("2026-11-12T18:00:00.000Z");
    expect(due({ ...on(null, "09:00"), words: "утром" }, "2026-11-12T13:00:00Z")).toBe("2026-11-13T08:00:00.000Z");
    expect(due({ ...on("2026-11-12", "09:00"), words: "сегодня утром" }, "2026-11-12T13:00:00Z")).toBe("past");
    expect(due({ ...on(null, "19:00"), words: "в 19:00" }, "2026-11-12T19:00:00Z")).toBe("2026-11-13T18:00:00.000Z");
  });

  it("turns down a time that has passed, one under a minute away, one more than five years on, and one it cannot read", () => {
    expect(due(on("2026-11-11"), "2026-11-12T10:00:00Z")).toBe("past");
    expect(due(span(0.5, "minutes"), "2026-11-12T10:00:00Z")).toBe("too_soon");
    expect(due(on(null, "14:28"), "2026-11-12T13:27:30Z")).toBe("too_soon");
    expect(due(span(5, "years"), "2026-11-12T10:00:00Z")).toBe("2031-11-12T10:00:00.000Z");
    expect(due(on("2031-11-13"), "2026-11-12T10:00:00Z")).toBe("too_far");
    expect(due(span(1e12, "years"), "2026-11-12T10:00:00Z")).toBe("too_far");
    expect(due(on("2027-02-30"), "2026-11-12T10:00:00Z")).toBe("bad_time");
    expect(due(on(null, "25:00"), "2026-11-12T10:00:00Z")).toBe("bad_time");
    expect(due(span(1.5, "months"), "2026-11-12T10:00:00Z")).toBe("bad_time");
    expect(due({ in: [{ amount: 2, unit: "days" }], date: "2027-01-01", time: null }, "2026-11-12T10:00:00Z")).toBe("bad_time");
    expect(due(on(null), "2026-11-12T10:00:00Z")).toBe("no_time");
  });

  it("shows the reading three weeks of the member's own calendar, today and tomorrow marked", () => {
    // 00:30 on the 13th in Warsaw while it is still the 12th in UTC.
    const days = calendarDays(new Date("2026-11-12T23:30:00Z"), WARSAW);
    expect(days).toHaveLength(21);
    expect(days.slice(0, 3)).toEqual(["2026-11-13 Fri (today)", "2026-11-14 Sat (tomorrow)", "2026-11-15 Sun"]);
    expect(days[20]).toBe("2026-12-03 Thu");
  });
});

describe("a reminder's words", () => {
  it("reads only a message with a reminder word, and only its own words as asking for what it was read as", () => {
    for (const text of ["напомни завтра в 10 позвонить в банк", "какие у меня напоминания?", "remind me in 3 days to renew the domain"]) expect(REMIND_CUE.test(text), text).toBe(true);
    expect(REMIND_CUE.test("запиши мне стек: Rust")).toBe(false);
    const read = (kind: ReminderReading["kind"], asks: string) => ({ kind, asks });
    expect(reminderStandsIn(read("remind", "напомни завтра в 10"), "напомни завтра в 10 позвонить в банк")).toBe(true);
    expect(reminderStandsIn(read("for_others", "напомни Киту"), "запиши мне стек")).toBe(false);
    expect(reminderStandsIn(read("remind", "завтра в 10"), "завтра в 10")).toBe(false);
    expect(reminderStandsIn(read("remind", "завтра в 10"), "завтра в 10", true)).toBe(true);
    // A cancel cannot be undone: only words that ask to cancel make one, whatever the reading says.
    expect(reminderStandsIn(read("cancel", "отмени напоминание про банк"), "отмени напоминание про банк")).toBe(true);
    expect(reminderStandsIn(read("cancel", "больше не напоминай про релиз"), "больше не напоминай про релиз")).toBe(true);
    expect(reminderStandsIn(read("cancel", "напомни мне это через неделю"), "напомни мне это через неделю")).toBe(false);
    expect(reminderStandsIn(read("cancel", "завтра в 10"), "завтра в 10", true)).toBe(false);
  });

  it("takes no field that names a person, a chat or a row", () => {
    const when = { words: "завтра в 10", in: null, date: "2026-11-13", time: "10:00", before: null };
    const reading = { kind: "remind", asks: "напомни", also_asks: false, text: "позвонить в банк", when, ref: null };
    expect(ReminderReadingSchema.safeParse(reading).success).toBe(true);
    expect(ReminderReadingSchema.safeParse({ ...reading, user_id: 7 }).success).toBe(false);
    expect(ReminderReadingSchema.safeParse({ ...reading, when: { ...when, chat_id: -100 } }).success).toBe(false);
    expect(ReminderReadingSchema.safeParse({ ...reading, when: { ...when, in: [{ amount: 2, unit: "fortnights" }] } }).success).toBe(false);
    expect(ReminderReadingSchema.safeParse({ ...reading, when: { ...when, before: [{ amount: 1, unit: "days", user_id: 7 }] } }).success).toBe(false);
  });

  it("keeps a reminder's text as it was written, though the reading saw it masked", () => {
    const original = "напомни завтра позвонить в банк 8 900 000-00-01, потом 8 900 000-00-02 и написать bob@example.com";
    expect(maskPersonalData(original)).toBe("напомни завтра позвонить в банк [phone], потом [phone] и написать [email]");
    expect(unmaskFrom("позвонить в банк [phone]", [original])).toBe("позвонить в банк 8 900 000-00-01");
    expect(unmaskFrom("Потом [phone] и написать [email]", [original])).toBe("Потом 8 900 000-00-02 и написать bob@example.com");
    // Worded anew, a placeholder takes the only value of its kind, and stays one when there are several.
    expect(unmaskFrom("написать Бобу на [email]", ["тут", original])).toBe("написать Бобу на bob@example.com");
    expect(unmaskFrom("набрать [phone]", [original])).toBe("набрать [phone]");
    expect(unmaskFrom("позвонить в банк", [original])).toBe("позвонить в банк");
  });

  it("writes dates and lateness as the chat reads them, and pings nobody with a member's text", () => {
    expect(dueLabel(new Date("2027-01-12T13:28:00Z"), WARSAW, "Russian")).toBe("12 января 2027, 14:28");
    expect(dueLabel(new Date("2027-01-12T13:28:00Z"), WARSAW, "English")).toBe("12 January 2027, 14:28");
    expect(lateBy(3 * 3_600_000 + 20 * 60_000, "Russian")).toBe("3 ч 20 мин");
    expect(lateBy(2 * 86_400_000 + 4 * 3_600_000, "English")).toBe("2 d 4 h");
    const due = chatReminderText({ tgId: 42, name: "Bob <b>", text: "написать @kit_k про <релиз>", lateMs: 0, privateMissed: false, botUsername: "waggle_test_bot", language: "Russian" });
    expect(due).toBe('⏰ <a href="tg://user?id=42">Bob &lt;b&gt;</a>, напоминаю: «написать @\u2060kit_k про &lt;релиз&gt;»');
    const late = chatReminderText({ tgId: 42, name: "Bob", text: "renew the domain", lateMs: 3 * 3_600_000, privateMissed: true, botUsername: "waggle_test_bot", language: "English" });
    expect(shown(late).split("\n").slice(1)).toEqual(["⌛ 3 h late: I was offline.", "📭 It didn't reach your private chat: start me there (t.me/waggle_test_bot) and the next ones will come there too."]);
    expect(privateReminderText({ chatId: -1001234567890, chatTitle: "Hive", sourceMsgId: 77, text: "renew the domain", lateMs: 0, language: "English" })).toBe(
      '⏰ A reminder from «Hive»: «renew the domain»\n<a href="https://t.me/c/1234567890/77">Your request</a>',
    );
  });

  it("shows the reading their words, their own reminders, their clock and their calendar", () => {
    const pending = [{ id: 5, due_at: new Date("2026-11-20T09:00:00Z"), text: "позвонить в банк <срочно>" }] as MemberReminder[];
    const now = new Date("2026-11-12T10:00:00Z");
    const words = [{ text: "напомни мне это через неделю", original: "напомни мне это через неделю", at: now }];
    const prompt = reminderPrompt({ words, replyTo: { author: "member", text: "релиз в пятницу", original: "релиз в пятницу", at: new Date("2026-11-12T09:00:00Z") }, pending, zone: JAKARTA, now });
    expect(prompt).toContain("<their_words>\n- напомни мне это через неделю\n</their_words>");
    expect(prompt).toContain('<they_reply_to from="another member" written="2026-11-12 Thu 16:00">\nрелиз в пятницу\n</they_reply_to>');
    expect(prompt).toContain("r1 2026-11-20 Fri 16:00: позвонить в банк срочно");
    expect(prompt).toContain("<now>2026-11-12 Thu 17:00, Asia/Jakarta</now>");
    expect(prompt).toContain("2026-11-13 Fri (tomorrow)");
    expect(prompt).not.toContain("(past)");
  });

  it("dates the messages a request refers to, and reaches the calendar back to an earlier day they were written on", () => {
    // Monday evening Kit wrote of a call «завтра»; Bob replies on Tuesday morning: «завтра» there is Tuesday.
    const now = new Date("2026-11-17T08:00:00Z");
    const replyTo = { author: "member" as const, text: "созвон завтра в 15:00", original: "созвон завтра в 15:00", at: new Date("2026-11-16T17:00:00Z") };
    const earlier = { text: "@waggle_test_bot напомни завтра", original: "@waggle_test_bot напомни завтра", at: new Date("2026-11-16T22:40:00Z") };
    const prompt = reminderPrompt({ words: [{ text: "напомни мне об этом", original: "напомни мне об этом", at: now }, earlier], replyTo, pending: [], zone: WARSAW, now });
    expect(prompt).toContain('<they_reply_to from="another member" written="2026-11-16 Mon 18:00">');
    expect(prompt).toContain("- (written 2026-11-16 Mon 23:40) @waggle_test_bot напомни завтра");
    expect(prompt).toContain("<calendar>\n2026-11-16 Mon (past)\n2026-11-17 Tue (today)\n2026-11-18 Wed (tomorrow)\n");
    // A message from over two weeks back does not stretch the calendar: its day words tell nothing.
    expect(calendarDays(now, WARSAW, new Date("2026-10-20T10:00:00Z"))[0]).toBe("2026-11-17 Tue (today)");
    expect(calendarDays(now, WARSAW, new Date("2026-11-14T10:00:00Z")).slice(0, 4)).toEqual(["2026-11-14 Sat (past)", "2026-11-15 Sun (past)", "2026-11-16 Mon (past)", "2026-11-17 Tue (today)"]);
  });

  it("counts a span or a time of day from the message its words stand in", () => {
    const newest = { text: "позвонить в банк", at: new Date("2026-11-12T13:45:00Z") };
    const earlier = { text: "@waggle_test_bot напомни через час", at: new Date("2026-11-12T13:00:00Z") };
    const replied = { text: "встреча через полчаса, не опаздывайте", at: new Date("2026-11-12T13:30:00Z") };
    const sources = [newest, earlier, replied];
    expect(writtenWhen("через час", sources, newest.at)).toEqual(earlier.at);
    expect(writtenWhen("через полчаса", sources, newest.at)).toEqual(replied.at);
    expect(writtenWhen("через 2 дня", sources, newest.at)).toEqual(newest.at);
    expect(writtenWhen(null, sources, newest.at)).toEqual(newest.at);
    // «через час», written at 14:00 and given its text at 14:45, is due at 15:00.
    expect(due({ ...span(1, "hours"), words: "через час" }, newest.at.toISOString(), WARSAW, earlier.at)).toBe("2026-11-12T14:00:00.000Z");
  });
});

describe.skipIf(!DATABASE_URL)("reminders members ask for", () => {
  let sql: Sql;
  let nextChat = -1001000000700;
  let nextTgId = 7710;
  let nextMsgId = 70_000;
  /** The bot's own message ids, unique across the tests as in Telegram. */
  let nextBotMsgId = 700_000;
  const me = { id: 4343, is_bot: true, first_name: "Waggle", username: "waggle_test_bot" } as unknown as UserFromGetMe;
  const config = { BOT_TOKEN: "123456:TEST-TOKEN", REPLY_MODEL: "claude-haiku-5-5", MONTHLY_LLM_BUDGET_USD: 500, CHAT_MONTHLY_BUDGET_USD: 50, DISPLAY_TIMEZONE: WARSAW };

  beforeAll(async () => {
    sql = createSql(DATABASE_URL!);
    await sql`DROP SCHEMA public CASCADE`;
    await sql`CREATE SCHEMA public`;
    await migrate(sql);
  });

  afterAll(async () => {
    await sql?.end();
  });

  async function newChat(id?: number): Promise<number> {
    const chatId = id ?? (nextChat -= 1);
    await registerChat(sql, chatId, "Hive", null);
    await setChatStatus(sql, chatId, "approved", null);
    return chatId;
  }

  type Member = User & { tg: { id: number; is_bot: false; first_name: string } };

  async function member(chatId: number, name: string): Promise<Member> {
    const tg = { id: ++nextTgId, is_bot: false as const, first_name: name };
    return { ...(await resolveUser(sql, tg, [OWNER], chatId)), tg };
  }

  async function say(chatId: number, user: User, text: string, at = new Date()): Promise<Message> {
    const msgId = ++nextMsgId;
    await saveMessage(sql, { chatId, msgId, userId: user.id, sentAt: at, text, replyToMsgId: null, isForward: false, forwardSource: null, mediaType: null });
    return { message_id: msgId, date: Math.floor(at.getTime() / 1000), chat: { id: chatId, type: "supergroup", title: "Hive" }, text } as unknown as Message;
  }

  /** A chat the bot reads as Russian, so its own lines come in Russian. */
  async function russianChat(): Promise<number> {
    const chat = await newChat();
    await say(chat, await member(chat, "Ann"), "Сегодня выкатила новую версию своего проекта, работает заметно быстрее прежней");
    return chat;
  }

  /** A reading as a test writes it: its quote of the request is the message itself unless given. */
  type Reading = Partial<ReminderReading> & Pick<ReminderReading, "kind">;
  /** A card request's reading, for a message the reminder reading leaves to the card requests. */
  type CardReading = { card: Omit<SelfEditResult, "asks"> };

  /** One reading per call, the last for every call after. */
  function fakeModel(results: (Reading | CardReading | Error)[], text: string) {
    const prompts: string[] = [];
    const asked = text.replace(/^@\w+\s*/, "");
    const client = {
      messages: {
        stream(params: { messages: { content: string }[] }) {
          prompts.push(params.messages[0]!.content);
          const result = results[Math.min(prompts.length, results.length) - 1]!;
          if (result instanceof Error) throw result;
          const payload =
            "card" in result
              ? { ...result.card, asks: asked }
              : { asks: result.kind === "not_a_reminder" ? null : asked, also_asks: false, text: null, when: { words: null, in: null, date: null, time: null, before: null }, ref: null, ...result };
          const message = { stop_reason: "end_turn", stop_details: null, content: [{ type: "text", text: JSON.stringify(payload) }], usage: { input_tokens: 600, output_tokens: 60 } };
          return { currentMessage: message, finalMessage: async () => message };
        },
      },
    } as unknown as Anthropic;
    return { client, prompts };
  }

  type Markup = { inline_keyboard: { text: string; callback_data?: string }[][] };

  function fakeApi() {
    const sent: { chatId: number; messageId: number; text: string; markup?: Markup }[] = [];
    const edited: { messageId: number; text: string }[] = [];
    const api = {
      sendMessage: async (chatId: number, text: string, options: { reply_markup?: Markup } = {}) => {
        const messageId = ++nextBotMsgId;
        sent.push({ chatId, messageId, text, markup: options.reply_markup });
        return { message_id: messageId };
      },
      editMessageText: async (_chatId: number, messageId: number, text: string) => {
        edited.push({ messageId, text });
        return true;
      },
    } as unknown as Api;
    return { api, sent, edited };
  }

  async function run(chatId: number, asker: Member, text: string, results: Reading | CardReading | Error | (Reading | CardReading | Error)[], extra: Partial<Message> = {}, at?: Date) {
    const model = fakeModel(Array.isArray(results) ? results : [results], text);
    const { api, sent, edited } = fakeApi();
    const answered: string[] = [];
    const lines: (string | undefined)[] = [];
    const answer = (_api: Api, question: { message: Message }, cardChange?: string, onAnswered?: (answered: null) => void) => {
      answered.push(question.message.text ?? "");
      lines.push(cardChange);
      onAnswered?.(null);
    };
    const edits = createSelfEdits({ sql, anthropic: model.client, config, answer, zonesOf: async () => new Map(), botNames: () => ["Waggle", "waggle_test_bot"], log: () => {} });
    const message = { ...(await say(chatId, asker, text, at)), from: asker.tg, ...extra };
    edits.handle(api, { chatId, chatTitle: "Hive", message: message as Message, from: asker.tg, me }, asker);
    await edits.idle();
    return { model, sent, edited, answered, lines, message };
  }

  /** The cancel buttons as Telegram would press them, through the real handler. */
  function fakeButtons() {
    let pattern: RegExp | undefined;
    let handler: ((ctx: unknown) => Promise<unknown>) | undefined;
    const bot = { callbackQuery: (re: RegExp, fn: (ctx: unknown) => Promise<unknown>) => ((pattern = re), (handler = fn)) } as unknown as Bot<BotContext>;
    registerReminders(bot, { sql, config, log: () => {} });
    return async (from: Member["tg"], data: string, chatId: number, messageId: number) => {
      const toasts: (string | undefined)[] = [];
      const edits: { text: string; markup?: Markup }[] = [];
      const elsewhere: { messageId: number; text: string }[] = [];
      await handler!({
        match: pattern!.exec(data),
        from,
        callbackQuery: { data, message: { chat: { id: chatId }, message_id: messageId } },
        answerCallbackQuery: async (options?: { text?: string }) => void toasts.push(options?.text),
        editMessageText: async (text: string, options?: { reply_markup?: Markup }) => void edits.push({ text, markup: options?.reply_markup }),
        api: { editMessageText: async (_chatId: number, editedId: number, text: string) => void elsewhere.push({ messageId: editedId, text }) },
      });
      return { toasts, edits, elsewhere };
    };
  }

  const remindersOf = (chatId: number) => sql<MemberReminder[]>`SELECT * FROM reminders WHERE chat_id = ${chatId} ORDER BY id`;
  const requestOf = async (chatId: number, msgId: number) =>
    (await sql<{ kind: string; status: string; receipt_msg_id: number | null }[]>`SELECT kind, status, receipt_msg_id FROM self_edits WHERE chat_id = ${chatId} AND msg_id = ${msgId}`)[0]!;
  const remind = (text: string, when: Partial<ReminderReading["when"]>, extra: Partial<ReminderReading> = {}): Reading => ({
    kind: "remind",
    text,
    when: { words: null, in: null, date: null, time: null, before: null, ...when },
    ...extra,
  });
  /** A reminder put straight into the table, due `minutesAgo` minutes ago (ahead when negative), as the delivery finds it. */
  async function dueReminder(chatId: number, user: Pick<User, "id">, text: string, options: { minutesAgo?: number; language?: string } = {}) {
    const [row] = await sql<MemberReminder[]>`
      INSERT INTO reminders (chat_id, user_id, text, due_at, time_zone, language, source_msg_id)
      VALUES (${chatId}, ${user.id}, ${text}, ${new Date(Date.now() - (options.minutesAgo ?? 5) * 60_000)}, ${WARSAW}, ${options.language ?? "Russian"}, ${++nextMsgId})
      RETURNING *`;
    return row!;
  }
  const reminderRow = async (id: number) => (await sql<MemberReminder[]>`SELECT * FROM reminders WHERE id = ${id}`)[0]!;
  /** The wait after a failed try is over: the next tick may take the reminder again. */
  const waitOut = () => sql`UPDATE reminders SET claimed_at = claimed_at - interval '2 hours' WHERE status = 'pending' AND claimed_at IS NOT NULL`;

  type SendOptions = { reply_parameters?: unknown; message_thread_id?: number };
  function deliveryApi(failures: { private?: (options: SendOptions) => Error | undefined; chat?: (options: SendOptions) => Error | undefined } = {}) {
    const calls: { chatId: number; text: string; options: SendOptions }[] = [];
    const retired: { chatId: number; messageId: number }[] = [];
    const api = {
      sendMessage: async (chatId: number, text: string, options: SendOptions = {}) => {
        const failure = chatId > 0 ? failures.private?.(options) : failures.chat?.(options);
        if (failure) throw failure;
        calls.push({ chatId, text, options });
        return { message_id: ++nextBotMsgId };
      },
      editMessageReplyMarkup: async (chatId: number, messageId: number) => void retired.push({ chatId, messageId }),
    } as unknown as Api;
    const deliver = (stopping?: () => boolean) => deliverDueReminders({ sql, api, botUsername: "waggle_test_bot", config: { MESSAGE_RETENTION_DAYS: 7 }, log: () => {} }, stopping);
    return { calls, retired, deliver };
  }
  const telegramError = (code: number, description: string) => new GrammyError(`Call to 'sendMessage' failed! (${code}: ${description})`, { ok: false, error_code: code, description }, "sendMessage", {});

  it("sets a reminder from the member's own words on their own clock, with a receipt and a cancel button only they can use", async () => {
    const chat = await russianChat();
    const bob = await member(chat, "Bob");
    const kit = await member(chat, "Kit");
    await sql`UPDATE members SET time_zone = ${JAKARTA}, time_zone_source = 'chat', time_zone_set_at = now() WHERE chat_id = ${chat} AND user_id = ${bob.id}`;
    const asked = await run(chat, bob, "@waggle_test_bot напомни через 2 дня проверить, взлетел ли релиз", remind("проверить, взлетел ли релиз", { in: [{ amount: 2, unit: "days" }] }));
    expect(asked.answered).toEqual([]);
    expect(asked.model.prompts[0]).toContain("<calendar>");
    expect(asked.model.prompts[0]).toMatch(/<now>\d{4}-\d{2}-\d{2} \w{3} \d{2}:\d{2}, Asia\/Jakarta<\/now>/);
    const [reminder] = await remindersOf(chat);
    expect(reminder).toMatchObject({ user_id: bob.id, text: "проверить, взлетел ли релиз", status: "pending", time_zone: JAKARTA, language: "Russian", source_msg_id: asked.message.message_id });
    // Jakarta keeps no summer time: two days on its calendar are 48 hours.
    expect(Math.abs(reminder!.due_at.getTime() - (asked.message.date * 1000 + 2 * 86_400_000))).toBeLessThan(5_000);
    const receipt = asked.sent[0]!;
    expect(asked.sent).toHaveLength(1);
    expect(receipt.text).toBe(
      `⏰ Напомню ${dueLabel(reminder!.due_at, JAKARTA, "Russian")} (по твоему времени, Asia/Jakarta): «проверить, взлетел ли релиз». Напишу здесь, а в личку — как только запустишь меня там: t.me/waggle_test_bot.`,
    );
    expect(receipt.markup!.inline_keyboard).toEqual([[{ text: "✖️ Отменить", callback_data: `rm:cancel:${reminder!.id}` }]]);
    expect(reminder!.receipt_msg_id).toBe(receipt.messageId);
    expect(await requestOf(chat, asked.message.message_id)).toEqual({ kind: "reminder", status: "applied", receipt_msg_id: receipt.messageId });

    const press = fakeButtons();
    const id = reminder!.id;
    expect((await press(kit.tg, `rm:cancel:${id}`, chat, receipt.messageId)).toasts).toEqual(["Это не твоё напоминание"]);
    expect((await press(bob.tg, `rm:cancel:${id}`, chat, receipt.messageId + 1)).toasts).toEqual(["Это не твоё напоминание"]);
    expect((await press(bob.tg, `rm:cancel:${id}`, chat - 1, receipt.messageId)).toasts).toEqual(["Это не твоё напоминание"]);
    expect((await reminderRow(id)).status).toBe("pending");
    const tapped = await press(bob.tg, `rm:cancel:${id}`, chat, receipt.messageId);
    expect(tapped.toasts).toEqual(["Отменил"]);
    expect(tapped.edits).toEqual([{ text: `✖️ Отменил напоминание на ${dueLabel(reminder!.due_at, JAKARTA, "Russian")}: «проверить, взлетел ли релиз».`, markup: undefined }]);
    expect((await reminderRow(id)).status).toBe("cancelled");
    expect((await press(bob.tg, `rm:cancel:${id}`, chat, receipt.messageId)).toasts).toEqual(["Уже отменено"]);
  });

  it("writes the receipt on the chat's clock when the member's own is unknown, and promises the private chat once they started it", async () => {
    const chat = await newChat();
    const bob = await member(chat, "Bob");
    await sql`UPDATE users SET dm_started = true WHERE id = ${bob.id}`;
    const tomorrow = isoDayIn(new Date(Date.now() + 86_400_000), WARSAW);
    const asked = await run(chat, { ...bob, dm_started: true }, "@waggle_test_bot remind me tomorrow at 10 to call the bank", remind("call the bank", { date: tomorrow, time: "10:00" }));
    const [reminder] = await remindersOf(chat);
    expect(reminder!.due_at.toISOString()).toBe(localInstant({ year: Number(tomorrow.slice(0, 4)), month: Number(tomorrow.slice(5, 7)), day: Number(tomorrow.slice(8)) }, { hour: 10, minute: 0 }, WARSAW).toISOString());
    expect(shown(asked.sent[0]!.text)).toBe(`⏰ I'll remind you on ${dueLabel(reminder!.due_at, WARSAW, "English")} (the chat's time, Europe/Warsaw): «call the bank». I'll write here and in a private message.`);
  });

  it("lists the member's own reminders soonest first with a cancel button each, and a tap there shows what is left", async () => {
    const chat = await russianChat();
    const bob = await member(chat, "Bob");
    const kit = await member(chat, "Kit");
    await run(chat, bob, "@waggle_test_bot напомни через 3 дня проверить релиз", remind("проверить релиз", { in: [{ amount: 3, unit: "days" }] }));
    const bank = await run(chat, bob, "@waggle_test_bot напомни через день позвонить в банк", remind("позвонить в банк", { in: [{ amount: 1, unit: "days" }] }));
    await run(chat, kit, "@waggle_test_bot напомни через час выключить духовку", remind("выключить духовку", { in: [{ amount: 1, unit: "hours" }] }));
    const [release, call] = (await remindersOf(chat)).filter((reminder) => reminder.user_id === bob.id);

    const listed = await run(chat, bob, "@waggle_test_bot какие у меня напоминания?", { kind: "list" });
    expect(listed.model.prompts[0]).toMatch(/r1 [^\n]*: позвонить в банк\nr2 [^\n]*: проверить релиз/);
    expect(listed.model.prompts[0]).not.toContain("духовку");
    const list = listed.sent[0]!;
    expect(list.text.split("\n")).toEqual([
      "⏰ Твои напоминания здесь (по времени чата, Europe/Warsaw):",
      `1. ${dueLabel(call!.due_at, WARSAW, "Russian")}: «позвонить в банк»`,
      `2. ${dueLabel(release!.due_at, WARSAW, "Russian")}: «проверить релиз»`,
    ]);
    expect(list.markup!.inline_keyboard).toEqual([[{ text: "✖️ 1", callback_data: `rm:cancel:${call!.id}` }, { text: "✖️ 2", callback_data: `rm:cancel:${release!.id}` }]]);
    expect(await requestOf(chat, listed.message.message_id)).toEqual({ kind: "reminder", status: "answered", receipt_msg_id: list.messageId });

    const press = fakeButtons();
    expect((await press(kit.tg, `rm:cancel:${call!.id}`, chat, list.messageId)).toasts).toEqual(["Это не твоё напоминание"]);
    const tapped = await press(bob.tg, `rm:cancel:${call!.id}`, chat, list.messageId);
    expect(tapped.toasts).toEqual(["Отменил"]);
    expect(tapped.edits[0]!.text.split("\n")).toEqual(["⏰ Твои напоминания здесь (по времени чата, Europe/Warsaw):", `1. ${dueLabel(release!.due_at, WARSAW, "Russian")}: «проверить релиз»`]);
    expect(tapped.edits[0]!.markup!.inline_keyboard).toEqual([[{ text: "✖️ 1", callback_data: `rm:cancel:${release!.id}` }]]);
    // The cancelled reminder's own receipt loses its button too.
    expect(tapped.elsewhere).toEqual([{ messageId: bank.sent[0]!.messageId, text: expect.stringMatching(/^✖️ Отменил напоминание на .*: «позвонить в банк»\.$/) }]);
    expect((await reminderRow(call!.id)).status).toBe("cancelled");
  });

  it("cancels the reminder a request names, of its sender's own only, and says what it cancelled", async () => {
    const chat = await russianChat();
    const bob = await member(chat, "Bob");
    const kit = await member(chat, "Kit");
    const bank = await run(chat, bob, "@waggle_test_bot напомни через день позвонить в банк", remind("позвонить в банк", { in: [{ amount: 1, unit: "days" }] }));
    const release = await run(chat, bob, "@waggle_test_bot напомни через 3 дня проверить релиз", remind("проверить релиз", { in: [{ amount: 3, unit: "days" }] }));
    const [call, check] = await remindersOf(chat);

    // Someone else's request reaches only their own reminders, whatever it names.
    const stranger = await run(chat, kit, "@waggle_test_bot отмени напоминание Боба про банк", { kind: "cancel", ref: "r1" });
    expect(stranger.sent[0]!.text).toBe("Отменять нечего: напоминаний здесь у тебя нет.");
    expect((await reminderRow(call!.id)).status).toBe("pending");

    const cancelled = await run(chat, bob, "@waggle_test_bot отмени напоминание про банк", { kind: "cancel", ref: "r1" });
    expect(cancelled.sent[0]!.text).toBe(`✖️ Отменил напоминание на ${dueLabel(call!.due_at, WARSAW, "Russian")}: «позвонить в банк».`);
    expect(cancelled.edited).toEqual([{ messageId: bank.sent[0]!.messageId, text: cancelled.sent[0]!.text }]);
    expect((await reminderRow(call!.id)).status).toBe("cancelled");

    // Nothing tells which: the list comes with its buttons.
    const unsure = await run(chat, bob, "@waggle_test_bot отмени напоминание", { kind: "cancel", ref: "r7" });
    expect(unsure.sent[0]!.text.split("\n")[0]).toBe("Какое отменить? Нажми ✖️ с его номером.");
    expect(unsure.sent[0]!.markup!.inline_keyboard).toEqual([[{ text: "✖️ 1", callback_data: `rm:cancel:${check!.id}` }]]);

    // A reply to a reminder's receipt is about that reminder.
    const toReceipt = { reply_to_message: { message_id: release.sent[0]!.messageId, date: 0, chat: { id: chat, type: "supergroup", title: "Hive" }, from: me, text: "⏰" } } as unknown as Partial<Message>;
    await run(chat, bob, "@waggle_test_bot отмени это напоминание", { kind: "cancel", ref: null }, toReceipt);
    expect((await reminderRow(check!.id)).status).toBe("cancelled");
  });

  it("refuses to remind anyone else, and anyone who opted out, in its own fixed words", async () => {
    const chat = await russianChat();
    const bob = await member(chat, "Bob");
    const others = await run(chat, bob, "@waggle_test_bot напомни Киту завтра сдать отчёт", { kind: "for_others" });
    expect(others.sent[0]!.text).toBe("🔒 Напоминаю только тому, кто просит: ни другим людям, ни всему чату.");
    expect(others.answered).toEqual([]);
    expect(await requestOf(chat, others.message.message_id)).toMatchObject({ kind: "reminder", status: "refused" });
    await setOptOut(sql, bob.id, true, chat);
    const opted = await run(chat, bob, "@waggle_test_bot напомни через день позвонить в банк", remind("позвонить в банк", { in: [{ amount: 1, unit: "days" }] }));
    expect(opted.sent[0]!.text).toBe("Ничего не поставил: ты просил ничего о тебе не хранить; включить обратно: /me → 🔒");
    expect(await remindersOf(chat)).toEqual([]);
  });

  it("keeps the limits: no time gone by, none past five years, a text from their words of at most 500 characters, 20 waiting", async () => {
    const chat = await russianChat();
    const bob = await member(chat, "Bob");
    const yesterday = isoDayIn(new Date(Date.now() - 2 * 86_400_000), WARSAW);
    const refusals = [
      [await run(chat, bob, "@waggle_test_bot напомни позвонить в банк 3 дня назад", remind("позвонить в банк", { date: yesterday })), "это время уже прошло"],
      [await run(chat, bob, "@waggle_test_bot напомни через 6 лет позвонить в банк", remind("позвонить в банк", { in: [{ amount: 6, unit: "years" }] })), "это дальше, чем через 5 лет"],
      [await run(chat, bob, "@waggle_test_bot напомни через день позвонить в банк", remind("купить яхту", { in: [{ amount: 1, unit: "days" }] })), "этого нет в твоих словах"],
      [await run(chat, bob, `@waggle_test_bot напомни через день ${"очень ".repeat(90)}важное`, remind(`${"очень ".repeat(90)}важное`, { in: [{ amount: 1, unit: "days" }] })), "текст длиннее 500 знаков"],
    ] as const;
    for (const [outcome, why] of refusals) expect(outcome.sent[0]!.text).toBe(`Ничего не поставил: ${why}`);
    expect(await remindersOf(chat)).toEqual([]);

    for (let index = 0; index < 20; index += 1) {
      await sql`INSERT INTO reminders (chat_id, user_id, text, due_at, time_zone, source_msg_id) VALUES (${chat}, ${bob.id}, ${`дело ${index}`}, now() + interval '1 day', ${WARSAW}, ${index + 1})`;
    }
    const full = await run(chat, bob, "@waggle_test_bot напомни через день позвонить в банк", remind("позвонить в банк", { in: [{ amount: 1, unit: "days" }] }));
    expect(full.sent[0]!.text).toBe("Ничего не поставил: у тебя здесь уже 20 напоминаний, сначала отмени ненужные");
    expect(await remindersOf(chat)).toHaveLength(20);
  });

  it("leaves a message that asks for no reminder to the card requests, as if it had never been read for one", async () => {
    const chat = await newChat();
    const bob = await member(chat, "Bob");
    const question = await run(chat, bob, "@waggle_test_bot напомни, о чём мы вчера говорили?", { kind: "not_a_reminder" });
    expect(question.model.prompts).toHaveLength(1);
    expect(question.answered).toEqual(["@waggle_test_bot напомни, о чём мы вчера говорили?"]);
    expect(question.sent).toEqual([]);
    expect(await requestOf(chat, question.message.message_id)).toMatchObject({ kind: "not_a_request" });

    const card = await run(chat, bob, "@waggle_test_bot запиши мне стек: Rust, а напомню я тебе сам", [
      { kind: "not_a_reminder" },
      { card: { kind: "edit", also_asks: false, ops: [{ action: "add", field: "stack", ref: null, value: "Rust" }] } },
    ]);
    expect(card.model.prompts).toHaveLength(2);
    expect(card.model.prompts[1]).toContain("<their_card>");
    expect(await sql`SELECT value FROM facts WHERE chat_id = ${chat} AND user_id = ${bob.id}`).toEqual([{ value: "Rust" }]);
    expect(card.sent[0]!.markup!.inline_keyboard[0]![0]!.callback_data).toMatch(/^se:undo:\d+$/);
    expect(await remindersOf(chat)).toEqual([]);
  });

  it("asks in the answer for what a request is missing, never with a set phrase, and reads the reply to that answer with the request", async () => {
    const chat = await russianChat();
    const bob = await member(chat, "Bob");
    const vague = await run(chat, bob, "@waggle_test_bot напомни позвонить в банк", { kind: "unclear", text: "позвонить в банк" });
    expect(vague.sent).toEqual([]);
    expect(vague.lines).toEqual([expect.stringMatching(/^no reminder was set yet: .* could not tell when; .*never dictate a phrase.*never say you will remind them yourself$/)]);
    expect(await requestOf(chat, vague.message.message_id)).toMatchObject({ kind: "reminder_unclear", status: "answered" });

    // The answer asked when; a reply to it with no reminder word of its own is read with that request.
    const question = ++nextBotMsgId;
    await saveBotMessage(sql, { chatId: chat, msgId: question, sentAt: new Date(), text: "Когда напомнить?", replyToMsgId: vague.message.message_id });
    const toQuestion = { reply_to_message: { message_id: question, date: 0, chat: { id: chat, type: "supergroup", title: "Hive" }, from: me, text: "Когда напомнить?" } } as unknown as Partial<Message>;
    const tomorrow = isoDayIn(new Date(Date.now() + 86_400_000), WARSAW);
    const answered = await run(chat, bob, "завтра в 10", remind("позвонить в банк", { date: tomorrow, time: "10:00" }, { asks: "завтра в 10" }), toQuestion);
    expect(answered.model.prompts[0]).toContain("<you_asked_them>what their earlier request «напомни позвонить в банк» was missing");
    expect(answered.model.prompts[0]).toMatch(/<their_words>\n- завтра в 10\n- \(written \d{4}-\d{2}-\d{2} \w{3} \d{2}:\d{2}\) @waggle_test_bot напомни позвонить в банк\n<\/their_words>/);
    expect((await remindersOf(chat)).map((reminder) => reminder.text)).toEqual(["позвонить в банк"]);
    expect(answered.sent[0]!.text).toMatch(/^⏰ Напомню /);

    // The same words in reply to any other message of the bot's are not read for a reminder.
    const elsewhere = { reply_to_message: { message_id: ++nextBotMsgId, date: 0, chat: { id: chat, type: "supergroup", title: "Hive" }, from: me, text: "Как дела?" } } as unknown as Partial<Message>;
    const other = await run(chat, bob, "завтра в 10", remind("позвонить в банк", { date: tomorrow, time: "10:00" }, { asks: "завтра в 10" }), elsewhere);
    expect(other.model.prompts).toEqual([]);
    expect(await remindersOf(chat)).toHaveLength(1);
  });

  it("answers whatever else the message asks, told what the bot did, and keeps the request's text from the chronicler", async () => {
    const chat = await russianChat();
    const bob = await member(chat, "Bob");
    const both = await run(chat, bob, "@waggle_test_bot напомни через день позвонить в банк, и кто тут пишет на Rust?", remind("позвонить в банк", { in: [{ amount: 1, unit: "days" }] }, { also_asks: true }));
    expect(both.sent).toHaveLength(1);
    expect(both.lines).toEqual([expect.stringMatching(/^the bot itself set them a reminder of «позвонить в банк» for .* and posted its own receipt with a cancel button; never repeat it or promise anything about it in your own words$/)]);
    const vague = await run(chat, bob, "@waggle_test_bot напомни про отчёт", { kind: "unclear", text: "про отчёт" });

    const stored = await sql<{ chat_id: number; msg_id: number; user_id: number; sent_at: Date; text: string; reply_to_msg_id: null; is_forward: boolean; forward_source: null; media_type: null; from_bot: boolean }[]>`
      SELECT chat_id, msg_id, user_id, sent_at, text, reply_to_msg_id, is_forward, forward_source, media_type, from_bot FROM messages WHERE chat_id = ${chat} AND msg_id IN (${both.message.message_id}, ${vague.message.message_id}) ORDER BY msg_id`;
    const data = await batchDataFor(sql, chat, stored);
    expect(data.batch.map((message) => message.text)).toEqual(["[asked the bot for a reminder; the bot handled it]", "[asked the bot for a reminder without saying when or what of]"]);
  });

  it("delivers a due reminder privately, with a link to the request, and in the chat as a reply in its topic that mentions its author", async () => {
    const chat = await russianChat();
    const bob = await member(chat, "Bob");
    await sql`UPDATE users SET dm_started = true WHERE id = ${bob.id}`;
    const topic = { is_topic_message: true, message_thread_id: 55 } as Partial<Message>;
    const asked = await run(chat, { ...bob, dm_started: true }, "@waggle_test_bot напомни через час проверить, взлетел ли релиз", remind("проверить, взлетел ли релиз", { in: [{ amount: 1, unit: "hours" }] }), topic);
    const [reminder] = await remindersOf(chat);
    expect(reminder!.thread_id).toBe(55);
    await sql`UPDATE reminders SET due_at = now() - interval '1 minute' WHERE id = ${reminder!.id}`;

    const telegram = deliveryApi();
    await telegram.deliver();
    const mine = telegram.calls.filter((call) => call.chatId === chat || call.chatId === bob.tg.id);
    expect(mine).toEqual([
      {
        chatId: bob.tg.id,
        text: `⏰ Напоминание из «Hive»: «проверить, взлетел ли релиз»\n<a href="https://t.me/c/${String(chat).slice(4)}/${asked.message.message_id}">Твоя просьба</a>`,
        options: { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
      },
      {
        chatId: chat,
        text: `⏰ <a href="tg://user?id=${bob.tg.id}">Bob</a>, напоминаю: «проверить, взлетел ли релиз»`,
        options: {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          message_thread_id: 55,
          reply_parameters: { message_id: asked.message.message_id, allow_sending_without_reply: true },
        },
      },
    ]);
    const sent = await reminderRow(reminder!.id);
    expect(sent).toMatchObject({ status: "sent", attempts: 1, dm_error: null });
    expect(sent.chat_msg_id).not.toBeNull();
    expect(sent.dm_msg_id).not.toBeNull();
    expect(sent.sent_at).not.toBeNull();
    // Delivered is delivered: the next tick posts nothing.
    await telegram.deliver();
    expect(telegram.calls.filter((call) => call.chatId === chat || call.chatId === bob.tg.id)).toHaveLength(2);
  });

  it("stops writing privately to someone who blocked the bot, and says so in the chat", async () => {
    const chat = await russianChat();
    const bob = await member(chat, "Bob");
    await sql`UPDATE users SET dm_started = true WHERE id = ${bob.id}`;
    const reminder = await dueReminder(chat, bob, "позвонить в банк");
    const telegram = deliveryApi({ private: () => telegramError(403, "Forbidden: bot was blocked by the user") });
    await telegram.deliver();
    const posted = telegram.calls.filter((call) => call.chatId === chat);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.text.split("\n")).toEqual([
      `⏰ <a href="tg://user?id=${bob.tg.id}">Bob</a>, напоминаю: «позвонить в банк»`,
      "📭 В личку не дошло: запусти меня там (t.me/waggle_test_bot), и следующие придут и туда.",
    ]);
    expect(await reminderRow(reminder.id)).toMatchObject({ status: "sent", dm_msg_id: null, dm_error: expect.stringContaining("Forbidden") });
    expect((await sql<{ dm_started: boolean }[]>`SELECT dm_started FROM users WHERE id = ${bob.id}`)[0]!.dm_started).toBe(false);
  });

  it("tries again after a failure Telegram may get over, waits longer after each one, never posts twice in one place, and gives up after its last try", async () => {
    const chat = await russianChat();
    const bob = await member(chat, "Bob");
    const flaky = await dueReminder(chat, bob, "позвонить в банк");
    let floods = 1;
    const once = deliveryApi({ chat: () => (floods-- > 0 ? telegramError(429, "Too Many Requests: retry after 5") : undefined) });
    await once.deliver();
    expect(await reminderRow(flaky.id)).toMatchObject({ status: "pending", attempts: 1, chat_msg_id: null });
    // Not straight away: the next try waits a while after a failed one.
    await once.deliver();
    expect(await reminderRow(flaky.id)).toMatchObject({ status: "pending", attempts: 1 });
    await waitOut();
    await once.deliver();
    expect(await reminderRow(flaky.id)).toMatchObject({ status: "sent", attempts: 2 });
    expect(once.calls.filter((call) => call.chatId === chat)).toHaveLength(1);

    const stuck = await dueReminder(chat, bob, "проверить релиз");
    const flooded = deliveryApi({ chat: () => telegramError(429, "Too Many Requests: retry after 5") });
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await flooded.deliver();
      await waitOut();
    }
    expect(await reminderRow(stuck.id)).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS });
    await flooded.deliver();
    expect((await reminderRow(stuck.id)).attempts).toBe(MAX_ATTEMPTS);

    // A crash after the private message went out: taken again, it goes to the chat alone.
    await sql`UPDATE users SET dm_started = true WHERE id = ${bob.id}`;
    const halfSent = await dueReminder(chat, bob, "выключить духовку");
    await sql`UPDATE reminders SET status = 'sending', attempts = 1, claimed_at = now() - interval '11 minutes', dm_msg_id = 12345 WHERE id = ${halfSent.id}`;
    // One being sent just now is left alone.
    const underWay = await dueReminder(chat, bob, "полить цветы");
    await sql`UPDATE reminders SET status = 'sending', attempts = 1, claimed_at = now() - interval '2 minutes' WHERE id = ${underWay.id}`;
    const again = deliveryApi();
    await again.deliver();
    expect(again.calls.filter((call) => call.chatId === bob.tg.id)).toEqual([]);
    expect(again.calls.filter((call) => call.chatId === chat).map((call) => call.text)).toEqual([expect.stringContaining("«выключить духовку»")]);
    expect(await reminderRow(halfSent.id)).toMatchObject({ status: "sent", attempts: 2, dm_msg_id: 12345 });
    expect(await reminderRow(underWay.id)).toMatchObject({ status: "sending", attempts: 1 });
    await sql`UPDATE reminders SET status = 'failed' WHERE id = ${underWay.id}`;

    // A stop puts back what was taken and not yet tried, with no attempt spent on it.
    const waiting = await dueReminder(chat, bob, "забрать посылку");
    const stopped = deliveryApi();
    await stopped.deliver(() => true);
    expect(stopped.calls).toEqual([]);
    expect(await reminderRow(waiting.id)).toMatchObject({ status: "pending", attempts: 0, claimed_at: null });
    await stopped.deliver();
    expect(await reminderRow(waiting.id)).toMatchObject({ status: "sent", attempts: 1 });
  });

  it("says how late a reminder comes when the bot was down, and sends nothing to someone who opted out meanwhile", async () => {
    const chat = await russianChat();
    const bob = await member(chat, "Bob");
    const kit = await member(chat, "Kit");
    await dueReminder(chat, bob, "позвонить в банк", { minutesAgo: 3 * 60 + 1.5 });
    const kits = await dueReminder(chat, kit, "сдать отчёт");
    await sql`UPDATE members SET opted_out = true WHERE chat_id = ${chat} AND user_id = ${kit.id}`;
    const telegram = deliveryApi();
    await telegram.deliver();
    const posted = telegram.calls.filter((call) => call.chatId === chat).map((call) => call.text);
    expect(posted).toEqual([`⏰ <a href="tg://user?id=${bob.tg.id}">Bob</a>, напоминаю: «позвонить в банк»\n⌛ С опозданием на 3 ч 1 мин: меня не было на связи.`]);
    expect((await reminderRow(kits.id)).status).toBe("cancelled");
  });

  it("forgets a member's reminders with the rest of them, in one chat or everywhere, and deletes finished ones in time", async () => {
    const first = await russianChat();
    const second = await newChat();
    const bob = await member(first, "Bob");
    await resolveUser(sql, bob.tg, [OWNER], second);
    const kit = await member(first, "Kit");
    await run(first, bob, "@waggle_test_bot напомни через день позвонить в банк", remind("позвонить в банк", { in: [{ amount: 1, unit: "days" }] }));
    await run(second, bob, "@waggle_test_bot remind me in a day to call the bank", remind("call the bank", { in: [{ amount: 1, unit: "days" }] }));
    await run(first, kit, "@waggle_test_bot напомни через день сдать отчёт", remind("сдать отчёт", { in: [{ amount: 1, unit: "days" }] }));
    // «What do you know about me» lists what is still to come, their own only.
    expect((await waitingReminders(sql, first, bob.id)).map((reminder) => reminder.text)).toEqual(["позвонить в банк"]);
    await forgetUser(sql, bob.id, { chatId: first, messages: false });
    expect((await remindersOf(first)).map((reminder) => reminder.user_id)).toEqual([kit.id]);
    expect(await remindersOf(second)).toHaveLength(1);
    await forgetUser(sql, bob.id, { messages: false });
    expect(await remindersOf(second)).toEqual([]);

    const old = await dueReminder(first, kit, "старое дело");
    await sql`UPDATE reminders SET status = 'sent', sent_at = now() - interval '8 days' WHERE id = ${old.id}`;
    expect(await clearFinishedReminders(sql, 7)).toBe(1);
    expect((await remindersOf(first)).map((reminder) => reminder.text)).toEqual(["сдать отчёт"]);
  });

  it("carries reminders along when a group becomes a supergroup, and when a card is linked to an account", async () => {
    const group = await newChat(-(5_000_000 + Math.floor(Math.random() * 1_000_000)));
    const bob = await member(group, "Bob");
    const asked = await run(group, bob, "@waggle_test_bot remind me in a day to renew the domain", remind("renew the domain", { in: [{ amount: 1, unit: "days" }] }));
    const supergroup = await newChat();
    await migrateChat(sql, group, supergroup);
    expect(await remindersOf(group)).toEqual([]);
    const [moved] = await remindersOf(supergroup);
    expect(moved).toMatchObject({ user_id: bob.id, text: "renew the domain", status: "pending", source_msg_id: asked.message.message_id - 2 ** 31 });
    expect(moved!.receipt_msg_id).toBe(asked.sent[0]!.messageId - 2 ** 31);
    // Its own message stays behind in the old group: in the supergroup it comes as a message of its own.
    await sql`UPDATE reminders SET due_at = now() - interval '1 minute' WHERE id = ${moved!.id}`;
    const telegram = deliveryApi();
    await telegram.deliver();
    const posted = telegram.calls.filter((call) => call.chatId === supergroup);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.options.reply_parameters).toBeUndefined();

    const [card] = await sql<{ id: number }[]>`INSERT INTO users (display_name) VALUES ('Imported card') RETURNING id`;
    await sql`INSERT INTO members (chat_id, user_id) VALUES (${supergroup}, ${card!.id})`;
    const carded = await dueReminder(supergroup, card!, "старое дело", { minutesAgo: -60 * 24 });
    await mergeSeedUser(sql, card!.id, bob.id, bob.id);
    expect((await reminderRow(carded.id)).user_id).toBe(bob.id);
  });

  it("lets the self-edit role add, read and cancel only the subject's own reminders, and neither send nor move any", async () => {
    const chat = await newChat();
    const other = await newChat();
    const bob = await member(chat, "Bob");
    const kit = await member(chat, "Kit");
    const kits = await dueReminder(chat, kit, "сдать отчёт", { minutesAgo: -60 });
    const bobs = await dueReminder(chat, bob, "позвонить в банк", { minutesAgo: -60 });
    const subject = subjectOf(bob, chat, bob.tg);
    const as = <T>(work: (tx: Queryable) => Promise<T>) => asSubject(sql, subject, work);

    expect((await as((tx) => tx<{ id: number }[]>`SELECT id FROM reminders`)).map((row) => row.id)).toEqual([bobs.id]);
    expect((await ownPendingReminders(sql, subject)).map((row) => row.id)).toEqual([bobs.id]);
    const insert = (chatId: number, userId: number) => as((tx) => tx`
      INSERT INTO reminders (chat_id, user_id, text, due_at, time_zone, source_msg_id) VALUES (${chatId}, ${userId}, 'x', now() + interval '1 day', 'UTC', 1)`);
    await expect(insert(chat, kit.id)).rejects.toThrow();
    await expect(insert(other, bob.id)).rejects.toThrow();
    await expect(as((tx) => tx`INSERT INTO reminders (chat_id, user_id, text, due_at, time_zone, source_msg_id, status) VALUES (${chat}, ${bob.id}, 'x', now(), 'UTC', 1, 'sent')`)).rejects.toThrow();
    expect((await as((tx) => tx`UPDATE reminders SET status = 'cancelled' WHERE id = ${kits.id}`)).count).toBe(0);
    await expect(as((tx) => tx`UPDATE reminders SET status = 'sent' WHERE id = ${bobs.id}`)).rejects.toThrow();
    await expect(as((tx) => tx`UPDATE reminders SET due_at = now() WHERE id = ${bobs.id}`)).rejects.toThrow();
    await expect(as((tx) => tx`UPDATE reminders SET chat_msg_id = 1 WHERE id = ${bobs.id}`)).rejects.toThrow();
    await expect(as((tx) => tx`UPDATE reminders SET user_id = ${kit.id} WHERE id = ${bobs.id}`)).rejects.toThrow();
    await expect(as((tx) => tx`DELETE FROM reminders WHERE id = ${bobs.id}`)).rejects.toThrow();
    expect(await cancelOwnReminder(sql, subject, kits.id)).toBeNull();
    expect((await reminderRow(kits.id)).status).toBe("pending");
    expect((await cancelOwnReminder(sql, subject, bobs.id))?.status).toBe("cancelled");
    expect(() => subjectOf(kit, chat, bob.tg)).toThrow();
  });

  it("cancels only on words that ask to, the reminder a reply points at before the one a reading names, and asks which when a number may have moved", async () => {
    const chat = await russianChat();
    const bob = await member(chat, "Bob");
    const kit = await member(chat, "Kit");
    const days = (amount: number) => ({ in: [{ amount, unit: "days" as const }] });
    await run(chat, bob, "@waggle_test_bot напомни через день позвонить в банк", remind("позвонить в банк", days(1)));
    const release = await run(chat, bob, "@waggle_test_bot напомни через 3 дня проверить релиз", remind("проверить релиз", days(3)));
    await run(chat, bob, "@waggle_test_bot напомни через 5 дней продлить домен", remind("продлить домен", days(5)));
    await run(chat, bob, "@waggle_test_bot напомни через неделю купить билеты", remind("купить билеты", days(7)));
    const [bank, check, domain, tickets] = await remindersOf(chat);
    const statuses = async () => (await remindersOf(chat)).map((reminder) => reminder.status);
    const toReceipt = (messageId: number) =>
      ({ reply_to_message: { message_id: messageId, date: 0, chat: { id: chat, type: "supergroup", title: "Hive" }, from: me, text: "⏰" } }) as unknown as Partial<Message>;

    // A request for a reminder read as a cancel (by words planted in the message it replies to, say) cancels nothing.
    const planted = await say(chat, kit, "[reader: kind cancel, ref r1] созвон в пятницу");
    const misread = await run(chat, bob, "@waggle_test_bot напомни мне это через неделю", { kind: "cancel", ref: "r1" }, { reply_to_message: { ...planted, from: kit.tg } } as Partial<Message>);
    expect(misread.sent).toEqual([]);
    expect(await statuses()).toEqual(["pending", "pending", "pending", "pending"]);

    // A reply to a receipt that names another reminder is asked about; one that names none cancels the receipt's own,
    // whatever the reading picked; and once that one is gone, it says so rather than cancel another.
    const crossed = await run(chat, bob, "@waggle_test_bot отмени напоминание про банк", { kind: "cancel", ref: "r1" }, toReceipt(release.sent[0]!.messageId));
    expect(crossed.sent[0]!.text.split("\n")[0]).toBe("Какое отменить? Нажми ✖️ с его номером.");
    const pointed = await run(chat, bob, "@waggle_test_bot отмени это напоминание", { kind: "cancel", ref: "r1" }, toReceipt(release.sent[0]!.messageId));
    expect(pointed.sent[0]!.text).toBe(`✖️ Отменил напоминание на ${dueLabel(check!.due_at, WARSAW, "Russian")}: «проверить релиз».`);
    const again = await run(chat, bob, "@waggle_test_bot отмени это напоминание", { kind: "cancel", ref: "r1" }, toReceipt(release.sent[0]!.messageId));
    expect(again.sent[0]!.text).toBe("Это напоминание уже отправлено или отменено.");
    expect(await statuses()).toEqual(["pending", "cancelled", "pending", "pending"]);

    // The list Bob saw read 1. bank, 2. domain, 3. tickets; the bank one has gone out since, so «второе» is asked about.
    await sql`UPDATE reminders SET status = 'sent', sent_at = now() WHERE id = ${bank!.id}`;
    const second = await run(chat, bob, "@waggle_test_bot отмени второе напоминание", { kind: "cancel", ref: "r2" });
    expect(second.sent[0]!.text.split("\n")).toEqual([
      "Какое отменить? Нажми ✖️ с его номером.",
      `1. ${dueLabel(domain!.due_at, WARSAW, "Russian")}: «продлить домен»`,
      `2. ${dueLabel(tickets!.due_at, WARSAW, "Russian")}: «купить билеты»`,
    ]);
    expect(await statuses()).toEqual(["sent", "cancelled", "pending", "pending"]);
    // Named by its own words, it goes; and the only one left goes when nothing picks it by a number.
    await run(chat, bob, "@waggle_test_bot отмени напоминание про билеты", { kind: "cancel", ref: "r2" });
    await run(chat, bob, "@waggle_test_bot отмени напоминание", { kind: "cancel", ref: "r1" });
    expect(await statuses()).toEqual(["sent", "cancelled", "cancelled", "cancelled"]);
  });

  it("does both when a message asks for a reminder and for a change to the card, and reads the card request when the reminder reading fails", async () => {
    const chat = await russianChat();
    const bob = await member(chat, "Bob");
    const day = { in: [{ amount: 1, unit: "days" as const }] };
    const both = await run(chat, bob, "@waggle_test_bot запиши мне стек Rust и напомни через день обновить резюме", [
      remind("обновить резюме", day, { also_asks: true }),
      { card: { kind: "edit", also_asks: true, ops: [{ action: "add", field: "stack", ref: null, value: "Rust" }] } },
    ]);
    expect((await remindersOf(chat)).map((reminder) => reminder.text)).toEqual(["обновить резюме"]);
    expect(await sql`SELECT value FROM facts WHERE chat_id = ${chat} AND user_id = ${bob.id}`).toEqual([{ value: "Rust" }]);
    expect(both.sent.map((sent) => sent.markup!.inline_keyboard[0]![0]!.callback_data)).toEqual([expect.stringMatching(/^rm:cancel:\d+$/), expect.stringMatching(/^se:undo:\d+$/)]);
    expect(both.lines).toEqual([expect.stringMatching(/^the bot itself set them a reminder of «обновить резюме» for .*; \+ стек: «Rust»$/)]);
    expect(await requestOf(chat, both.message.message_id)).toEqual({ kind: "edit", status: "applied", receipt_msg_id: both.sent[1]!.messageId });
    const [reminder] = await remindersOf(chat);
    expect((await fakeButtons()(bob.tg, `rm:cancel:${reminder!.id}`, chat, both.sent[0]!.messageId)).toasts).toEqual(["Отменил"]);

    // A card word that is part of what to remind of: the record stays the reminder's, and the rest is answered.
    const video = await run(chat, bob, "@waggle_test_bot напомни через день записать видео, и как там погода?", [
      remind("записать видео", day, { also_asks: true }),
      { card: { kind: "not_a_request", also_asks: true, ops: [] } },
    ]);
    expect(video.sent).toHaveLength(1);
    expect(video.lines).toEqual([expect.stringMatching(/^the bot itself set them a reminder of «записать видео» for /)]);
    expect(await requestOf(chat, video.message.message_id)).toEqual({ kind: "reminder", status: "applied", receipt_msg_id: video.sent[0]!.messageId });

    // A reminder reading that fails leaves a card request in the message to be read as before…
    await run(chat, bob, "@waggle_test_bot добавь заметку: напомнить себе продлить домен", [
      new Error("overloaded"),
      { card: { kind: "edit", also_asks: false, ops: [{ action: "add_note", field: null, ref: null, value: "напомнить себе продлить домен" }] } },
    ]);
    expect(await sql`SELECT text FROM memos WHERE chat_id = ${chat} AND user_id = ${bob.id}`).toEqual([{ text: "напомнить себе продлить домен" }]);
    // …and a question with a reminder word is answered as one, told only that a reminder, if it asked for one, was not set.
    const question = await run(chat, bob, "@waggle_test_bot напомни, о чём мы вчера говорили?", new Error("overloaded"));
    expect(question.lines).toEqual([expect.stringMatching(/^if the message asks to be reminded of something, no reminder was set: .*answer it as usual and leave reminders out$/)]);
    expect(await requestOf(chat, question.message.message_id)).toMatchObject({ kind: "not_a_request", status: "answered" });
  });

  it("counts from when the words were written: a message read late, an earlier request a reply completes, a message it replies to", async () => {
    const chat = await russianChat();
    const bob = await member(chat, "Bob");
    const kit = await member(chat, "Kit");
    // Read two hours late, after a restart: three hours from when it was written, and <now> is then.
    const written = new Date(Date.now() - 2 * 3_600_000);
    const late = await run(chat, bob, "@waggle_test_bot напомни через 3 часа выключить духовку", remind("выключить духовку", { in: [{ amount: 3, unit: "hours" }], words: "через 3 часа" }), {}, written);
    expect(late.model.prompts[0]).toContain(`<now>${localStamp(written, WARSAW)}, Europe/Warsaw</now>`);
    const oven = (await remindersOf(chat)).find((reminder) => reminder.text === "выключить духовку");
    expect(Math.abs(oven!.due_at.getTime() - (written.getTime() + 3 * 3_600_000))).toBeLessThan(2_000);

    // «через час» 40 minutes ago, and what of only now: due 20 minutes from now.
    const asked = new Date(Date.now() - 40 * 60_000);
    const vague = await run(chat, bob, "@waggle_test_bot напомни через час", { kind: "unclear", when: { words: "через час", in: [{ amount: 1, unit: "hours" }], date: null, time: null, before: null } }, {}, asked);
    expect(vague.lines).toEqual([expect.stringMatching(/could not tell what to remind them of; ask in one short line/)]);
    const question = ++nextBotMsgId;
    await saveBotMessage(sql, { chatId: chat, msgId: question, sentAt: new Date(), text: "О чём напомнить?", replyToMsgId: vague.message.message_id });
    const toQuestion = { reply_to_message: { message_id: question, date: 0, chat: { id: chat, type: "supergroup", title: "Hive" }, from: me, text: "О чём напомнить?" } } as unknown as Partial<Message>;
    await run(chat, bob, "позвонить в банк", remind("позвонить в банк", { in: [{ amount: 1, unit: "hours" }], words: "через час" }, { asks: "позвонить в банк" }), toQuestion);
    const bank = (await remindersOf(chat)).find((reminder) => reminder.text === "позвонить в банк");
    expect(Math.abs(bank!.due_at.getTime() - (asked.getTime() + 3_600_000))).toBeLessThan(2_000);

    // What Kit wrote yesterday is shown with its day, which the calendar reaches back to.
    const said = new Date(Date.now() - 86_400_000);
    const call = await say(chat, kit, "созвон завтра в 15:00", said);
    const toCall = { reply_to_message: { ...call, from: kit.tg } } as Partial<Message>;
    const pointing = await run(chat, bob, "@waggle_test_bot напомни мне об этом", { kind: "unclear", text: "созвон" }, toCall);
    expect(pointing.model.prompts[0]).toContain(`<they_reply_to from="another member" written="${localStamp(said, WARSAW)}">\nсозвон завтра в 15:00\n</they_reply_to>`);
    expect(pointing.model.prompts[0]).toContain(`\n${isoDayIn(said, WARSAW)} ${localStamp(said, WARSAW).slice(11, 14)} (past)\n`);
  });

  it("asks for the hour of a day under way rather than refuse it as past, and refuses to remind again and again", async () => {
    const chat = await russianChat();
    const bob = await member(chat, "Bob");
    // «сегодня», written at 15:00 with no hour: the answer asks at what time.
    const day = wallClock(new Date(Date.now() - 86_400_000), WARSAW);
    const at = localInstant(day, { hour: 15, minute: 0 }, WARSAW);
    const today = await run(chat, bob, "@waggle_test_bot напомни сегодня позвонить в банк", remind("позвонить в банк", { date: isoDate(day), words: "сегодня" }), {}, at);
    expect(today.sent).toEqual([]);
    expect(today.lines).toEqual([expect.stringMatching(/^no reminder was set yet: .* could not tell at what time of that day; /)]);
    expect(await requestOf(chat, today.message.message_id)).toMatchObject({ kind: "reminder_unclear", status: "answered" });

    const refusal = "🔁 Повторять напоминания я не умею, ставлю только разовые: попроси напомнить один раз.";
    const weekly = await run(chat, bob, "@waggle_test_bot напоминай каждый понедельник проверять бэкапы", { kind: "recurring" });
    expect(weekly.sent.map((sent) => sent.text)).toEqual([refusal]);
    expect(await requestOf(chat, weekly.message.message_id)).toMatchObject({ kind: "reminder", status: "refused" });
    // Read as one reminder all the same, it is refused for the words that say how often.
    const monday = isoDayIn(new Date(Date.now() + 3 * 86_400_000), WARSAW);
    const misread = await run(chat, bob, "@waggle_test_bot напоминай каждый понедельник проверять бэкапы", remind("проверять бэкапы", { date: monday, words: "каждый понедельник" }));
    expect(misread.sent.map((sent) => sent.text)).toEqual([refusal]);
    expect(await remindersOf(chat)).toEqual([]);
  });

  it("keeps a mention of the bot inside the text it reminds of, and drops only the one that addresses it", async () => {
    const chat = await russianChat();
    const bob = await member(chat, "Bob");
    const asked = await run(chat, bob, "@waggle_test_bot напомни через 5 минут: держи цветок 🌸 @waggle_test_bot", remind("держи цветок 🌸 @waggle_test_bot", { in: [{ amount: 5, unit: "minutes" }] }));
    expect(asked.model.prompts[0]).toContain("- напомни через 5 минут: держи цветок 🌸 @waggle_test_bot\n");
    expect((await remindersOf(chat)).map((reminder) => reminder.text)).toEqual(["держи цветок 🌸 @waggle_test_bot"]);
    // Shown as written; a joiner after the @ keeps it from pinging anyone, as in every quoted reminder.
    expect(shown(asked.sent[0]!.text).replace(/\u2060/g, "")).toContain("«держи цветок 🌸 @waggle_test_bot»");
  });

  it("keeps the text it reminds of as the member wrote it, while the reading sees it masked", async () => {
    const chat = await russianChat();
    const bob = await member(chat, "Bob");
    const asked = await run(chat, bob, "@waggle_test_bot напомни через день позвонить в банк 8 900 000-00-01", remind("позвонить в банк [phone]", { in: [{ amount: 1, unit: "days" }] }));
    expect(asked.model.prompts[0]).toContain("- напомни через день позвонить в банк [phone]\n");
    expect(asked.model.prompts[0]).not.toContain("000-00-01");
    expect((await remindersOf(chat)).map((reminder) => reminder.text)).toEqual(["позвонить в банк 8 900 000-00-01"]);
    expect(shown(asked.sent[0]!.text)).toContain("«позвонить в банк 8 900 000-00-01»");
  });

  it("tries again only the place that missed a reminder, posts outside a topic that is gone, and takes the cancel button off a sent one's receipt", async () => {
    const chat = await russianChat();
    const bob = await member(chat, "Bob");
    await sql`UPDATE users SET dm_started = true WHERE id = ${bob.id}`;
    const placesOf = (calls: { chatId: number }[]) => calls.filter((call) => call.chatId === chat || call.chatId === bob.tg.id).map((call) => (call.chatId === chat ? "chat" : "private"));

    // The private message goes out and the chat floods: the next tick posts in the chat alone.
    const flooded = await dueReminder(chat, bob, "позвонить в банк");
    let floods = 1;
    const first = deliveryApi({ chat: () => (floods-- > 0 ? telegramError(429, "Too Many Requests: retry after 5") : undefined) });
    await first.deliver();
    expect(await reminderRow(flooded.id)).toMatchObject({ status: "pending", attempts: 1, chat_msg_id: null });
    expect((await reminderRow(flooded.id)).dm_msg_id).not.toBeNull();
    await waitOut();
    await first.deliver();
    expect(await reminderRow(flooded.id)).toMatchObject({ status: "sent", attempts: 2 });
    expect(placesOf(first.calls)).toEqual(["private", "chat"]);

    // The other way round: the chat takes it, the private chat is out of reach for a tick, then takes it too.
    const quiet = await dueReminder(chat, bob, "проверить релиз");
    let outages = 1;
    const second = deliveryApi({ private: () => (outages-- > 0 ? new Error("socket hang up") : undefined) });
    await second.deliver();
    expect(await reminderRow(quiet.id)).toMatchObject({ status: "pending", dm_msg_id: null });
    await waitOut();
    await second.deliver();
    expect(await reminderRow(quiet.id)).toMatchObject({ status: "sent", attempts: 2 });
    expect(placesOf(second.calls)).toEqual(["chat", "private"]);

    // A place that keeps failing does not hold back what went out elsewhere: sent after the last try.
    const stubborn = await dueReminder(chat, bob, "полить цветы");
    const third = deliveryApi({ private: () => telegramError(502, "Bad Gateway") });
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await third.deliver();
      await waitOut();
    }
    expect(await reminderRow(stubborn.id)).toMatchObject({ status: "sent", attempts: MAX_ATTEMPTS, dm_msg_id: null });
    expect(placesOf(third.calls)).toEqual(["chat"]);

    // Its forum topic deleted since, and no private chat: it goes outside the topic, as a message of its own.
    await sql`UPDATE users SET dm_started = false WHERE id = ${bob.id}`;
    const topical = await dueReminder(chat, bob, "забрать посылку");
    await sql`UPDATE reminders SET thread_id = 55 WHERE id = ${topical.id}`;
    const fourth = deliveryApi({ chat: (options) => (options.message_thread_id ? telegramError(400, "Bad Request: message thread not found") : undefined) });
    await fourth.deliver();
    expect(fourth.calls.filter((call) => call.chatId === chat).map((call) => call.options)).toEqual([{ parse_mode: "HTML", link_preview_options: { is_disabled: true } }]);
    expect(await reminderRow(topical.id)).toMatchObject({ status: "sent" });

    // A sent reminder's receipt loses its button; a tap on one left over says it went, and once deleted, that it is gone.
    const asked = await run(chat, bob, "@waggle_test_bot напомни через час позвонить маме", remind("позвонить маме", { in: [{ amount: 1, unit: "hours" }] }));
    const receipt = asked.sent[0]!.messageId;
    const mum = (await remindersOf(chat)).find((reminder) => reminder.text === "позвонить маме")!;
    await sql`UPDATE reminders SET due_at = now() - interval '1 minute' WHERE id = ${mum.id}`;
    const fifth = deliveryApi();
    await fifth.deliver();
    expect(fifth.retired).toEqual([{ chatId: chat, messageId: receipt }]);
    const press = fakeButtons();
    expect((await press(bob.tg, `rm:cancel:${mum.id}`, chat, receipt)).toasts).toEqual(["Уже отправил"]);
    await sql`DELETE FROM reminders WHERE id = ${mum.id}`;
    expect((await press(bob.tg, `rm:cancel:${mum.id}`, chat, receipt)).toasts).toEqual(["Это напоминание уже отправлено или отменено."]);
    // One that could not be delivered anywhere says that.
    const lost = await dueReminder(chat, bob, "оплатить счёт");
    await sql`UPDATE reminders SET status = 'failed', receipt_msg_id = ${receipt} WHERE id = ${lost.id}`;
    expect((await press(bob.tg, `rm:cancel:${lost.id}`, chat, receipt)).toasts).toEqual(["Его не вышло доставить"]);
  });

  it("says a cancel failed in words for a cancel, and leaves the reminder as it was", async () => {
    const chat = await russianChat();
    const bob = await member(chat, "Bob");
    await run(chat, bob, "@waggle_test_bot напомни через день позвонить в банк", remind("позвонить в банк", { in: [{ amount: 1, unit: "days" }] }));
    await sql`REVOKE UPDATE (status) ON reminders FROM waggle_self_edit`;
    try {
      const failed = await run(chat, bob, "@waggle_test_bot отмени напоминание про банк", { kind: "cancel", ref: "r1" });
      expect(failed.sent.map((sent) => sent.text)).toEqual(["🐝 Не вышло отменить напоминание, попробуй чуть позже."]);
      expect(await requestOf(chat, failed.message.message_id)).toMatchObject({ kind: "reminder", status: "failed" });
    } finally {
      await sql`GRANT UPDATE (status) ON reminders TO waggle_self_edit`;
    }
    expect((await remindersOf(chat)).map((reminder) => reminder.status)).toEqual(["pending"]);
  });

  it("blanks the chat copies of the reminders it delivered to someone who has it forget their messages, a reply or not", async () => {
    const chat = await russianChat();
    const bob = await member(chat, "Bob");
    const reminder = await dueReminder(chat, bob, "записаться к врачу");
    // Carried over from a group before it became a supergroup, it went out as a message of its own.
    const delivered = ++nextBotMsgId;
    await saveBotMessage(sql, { chatId: chat, msgId: delivered, sentAt: new Date(), text: "⏰ Bob, напоминаю: «записаться к врачу»", replyToMsgId: null });
    await sql`UPDATE reminders SET status = 'sent', sent_at = now(), chat_msg_id = ${delivered} WHERE id = ${reminder.id}`;
    await forgetUser(sql, bob.id, { chatId: chat, messages: true });
    expect(await sql`SELECT text FROM messages WHERE chat_id = ${chat} AND msg_id = ${delivered}`).toEqual([{ text: "" }]);
    expect(await remindersOf(chat)).toEqual([]);
  });
});
