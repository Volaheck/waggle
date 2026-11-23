import type Anthropic from "@anthropic-ai/sdk";
import { GrammyError, HttpError, type Api } from "grammy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dayIn, MAX_NEWS_PER_NOTE, newsFor, NOTES_FROM, NOTES_KEY } from "../src/core/announcements.js";
import type { Capability } from "../src/core/capabilities.js";
import { migrateChat } from "../src/core/chat-migration.js";
import { getChat, registerChat, setAnnouncements, setChatStatus, setIdeas, type Chat } from "../src/core/chats.js";
import { createSql, migrate, type Sql } from "../src/core/db.js";
import { resolveUser } from "../src/core/users.js";
import {
  ANNOUNCEMENT_SYSTEM_PROMPT,
  announceIn,
  notePost,
  notePrompt,
  startAnnouncements,
  writeNote,
  type Note,
  type NoteResult,
} from "../src/worker/announcements.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const OWNER = 9800;
const BOT = "waggle_test_bot";

const capability = (name: string, shipped: string): Capability => ({ name, does: `you ${name.toLowerCase()}`, how: `«${name}»`, limits: "a limit", shipped });

/** A zone where it is the afternoon now: the bot posts nothing at night, and the tests run at any hour. */
function afternoonZone(now = new Date()): string {
  const offset = ((14 - now.getUTCHours() + 36) % 24) - 12;
  return offset === 0 ? "UTC" : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`;
}

describe("what counts as news", () => {
  const list = {
    answers: capability("Answers", "2026-11-09"),
    [NOTES_KEY]: capability("Notes", NOTES_FROM),
    beta: capability("Beta", "2026-11-25"),
    alpha: capability("Alpha", NOTES_FROM),
    gamma: capability("Gamma", "2026-11-24"),
  };

  it("is what shipped from the day the notes began, after the bot joined the chat, and was not told of yet, oldest first", () => {
    const joined = new Date("2026-11-09T10:00:00Z");
    expect(newsFor(list, joined, new Set(), "Europe/Warsaw").map(([key]) => key)).toEqual(["alpha", "gamma", "beta"]);
    expect(newsFor(list, joined, new Set(["alpha", "beta"]), "Europe/Warsaw").map(([key]) => key)).toEqual(["gamma"]);
    // A chat the bot joined on the day something shipped was never without it.
    expect(newsFor(list, new Date("2026-11-24T08:00:00Z"), new Set(), "Europe/Warsaw").map(([key]) => key)).toEqual(["beta"]);
  });

  it("takes the joining day in the bot's time zone, and gives at most a few things at once", () => {
    // 23:30 UTC on 23 Nov is already 24 Nov in Warsaw.
    expect(dayIn(new Date("2026-11-23T23:30:00Z"), "Europe/Warsaw")).toBe("2026-11-24");
    expect(newsFor(list, new Date("2026-11-23T23:30:00Z"), new Set(), "Europe/Warsaw").map(([key]) => key)).toEqual(["beta"]);
    const many = Object.fromEntries(Array.from({ length: MAX_NEWS_PER_NOTE + 2 }, (_, index) => [`c${index}`, capability(`C${index}`, NOTES_FROM)]));
    expect(newsFor(many, new Date("2026-11-09T10:00:00Z"), new Set(), "UTC")).toHaveLength(MAX_NEWS_PER_NOTE);
  });
});

describe("the note's texts", () => {
  const news: [string, Capability][] = [
    ["alpha", capability("Alpha", NOTES_FROM)],
    ["beta", capability("Beta", NOTES_FROM)],
  ];

  it("asks for one short post on exactly the news given, in the chat's language, keeping to the chat's wishes", () => {
    for (const rule of ["one for each entry of <news>", "Never more than the entry says", "In your first post", "ruled_out", "Never name or address anyone", "the chat's language", "you write no other @handle"]) {
      expect(ANNOUNCEMENT_SYSTEM_PROMPT).toContain(rule);
    }
    const prompt = notePrompt(
      { language: "Russian", first: false, news, earlier: [{ text: "📣 Я научился <b>X</b>", created_at: new Date("2026-11-23T13:00:00Z") }], wishes: ["не пиши про политику"] },
      "Europe/Warsaw",
      BOT,
    );
    expect(prompt).toContain(`<you username="@${BOT}" />`);
    expect(prompt).toContain('<chat language="Russian" />');
    expect(prompt).toContain("<first>false</first>");
    expect(prompt).toContain("- alpha · Alpha: you alpha. How: «Alpha». Limits: a limit.");
    expect(prompt).toContain("- 23 Nov 2026: «📣 Я научился ‹b›X‹/b›»");
    expect(prompt).toContain("- «не пиши про политику»");
    expect(notePrompt({ language: null, first: true, news, earlier: [], wishes: [] }, "UTC", BOT)).not.toMatch(/<earlier_posts>|<wishes/);
  });

  it("puts the items in the news' order, the first good one of a key, escaped, links no one but the bot, and drops an empty closing line", () => {
    const result: NoteResult = {
      intro: "Я подрос <немного>",
      items: [
        { key: "beta", title: "Бета", text: `пишите @${BOT} «бета» & ждите` },
        { key: "alpha", title: "", text: "" },
        { key: "alpha", title: "Альфа", text: "напомните @kit или @Somebody_Else, mail@example.com" },
        { key: "alpha", title: "Лишняя", text: "второй раз" },
      ],
      ruled_out: [],
      outro: " ",
    };
    expect(notePost(result, news, BOT)).toBe(
      `📣 Я подрос &lt;немного&gt;\n\n• <b>Альфа</b> — напомните kit или Somebody_Else, mail@example.com\n• <b>Бета</b> — пишите @${BOT} «бета» &amp; ждите`,
    );
    expect(notePost({ ...result, outro: "Пробуйте!" }, news, BOT).endsWith("\n\nПробуйте!")).toBe(true);
  });
});

describe.skipIf(!DATABASE_URL)("the notes on what the bot learned", () => {
  let sql: Sql;
  let nextChat = -1001000000800;
  let nextTgId = 9810;
  const zone = afternoonZone();
  const config = { BOT_TOKEN: "123456:TEST-TOKEN", REPLY_PREMIUM_MODEL: "claude-opus-5-5", MONTHLY_LLM_BUDGET_USD: 500, CHAT_MONTHLY_BUDGET_USD: 50, DISPLAY_TIMEZONE: zone };
  const capabilities = { answers: capability("Answers", "2026-11-09"), alpha: capability("Alpha", NOTES_FROM), beta: capability("Beta", NOTES_FROM) };

  beforeAll(async () => {
    sql = createSql(DATABASE_URL!);
    await sql`DROP SCHEMA public CASCADE`;
    await sql`CREATE SCHEMA public`;
    await migrate(sql);
  });

  afterAll(async () => {
    await sql?.end();
  });

  /** An approved chat the bot joined on 9 Nov, before any of the news shipped. */
  async function newChat(id = (nextChat -= 1)): Promise<Chat> {
    await registerChat(sql, id, "Hive", null);
    await setChatStatus(sql, id, "approved", null);
    await sql`UPDATE chats SET created_at = '2026-11-09T10:00:00Z' WHERE id = ${id}`;
    return (await getChat(sql, id))!;
  }

  async function chatWish(chat: Chat, text: string) {
    const admin = await resolveUser(sql, { id: ++nextTgId, first_name: "Admin" }, [OWNER], chat.id);
    await sql`INSERT INTO wishes (chat_id, user_id, scope, text) VALUES (${chat.id}, ${admin.id}, 'chat', ${text})`;
  }

  function fakeModel(answer: (keys: string[]) => NoteResult, during?: () => Promise<unknown>) {
    const prompts: string[] = [];
    const schemas: string[][] = [];
    const client = {
      messages: {
        stream(params: { system: string; messages: { content: string }[]; output_config: { format: { schema: Record<string, any> } } }) {
          expect(params.system).toBe(ANNOUNCEMENT_SYSTEM_PROMPT);
          prompts.push(params.messages[0]!.content);
          const keys: string[] = params.output_config.format.schema.properties.items.items.properties.key.enum;
          schemas.push(keys);
          const message = { stop_reason: "end_turn", stop_details: null, content: [{ type: "text", text: JSON.stringify(answer(keys)) }], usage: { input_tokens: 3000, output_tokens: 400 } };
          return {
            currentMessage: message,
            finalMessage: async () => {
              await during?.();
              return message;
            },
          };
        },
      },
    } as unknown as Anthropic;
    return { client, prompts, schemas };
  }

  const every = (keys: string[]): NoteResult => ({
    intro: "Я кое-чему научился",
    items: keys.map((key) => ({ key, title: key.toUpperCase(), text: `про ${key}` })),
    ruled_out: [],
    outro: "",
  });

  function fakeApi(failures: unknown[] = []) {
    const sent: { chatId: number; text: string }[] = [];
    const api = {
      sendMessage: async (chatId: number, text: string) => {
        const failure = failures.shift();
        if (failure) throw failure;
        sent.push({ chatId, text });
        return { message_id: 800_000 + sent.length };
      },
    } as unknown as Api;
    return { api, sent };
  }

  const refused = (code: number, description: string) =>
    new GrammyError(`Call to 'sendMessage' failed! (${code}: ${description})`, { ok: false, error_code: code, description }, "sendMessage", {});
  const notes = (chatId: number) => sql<Note[]>`SELECT * FROM announcements WHERE chat_id = ${chatId} ORDER BY id`;
  /** As if the chat's notes were written, and posted, a day earlier. */
  const dayLater = (chatId: number) =>
    sql`UPDATE announcements SET created_at = created_at - interval '1 day', posted_at = posted_at - interval '1 day' WHERE chat_id = ${chatId}`;
  const depsWith = (model: { client: Anthropic }, api: Api, list: Record<string, Capability> = capabilities) => ({
    sql,
    anthropic: model.client,
    api,
    config,
    botUsername: BOT,
    capabilities: list,
  });

  it("tells a chat of its news once, in one post, and the first post says such notes will come", async () => {
    const chat = await newChat();
    // «Здорово» is no health topic: the stop-list is not run on a note written from the bot's own entries.
    const model = fakeModel((keys) => ({ ...every(keys), outro: "Здорово, правда?" }));
    const { api, sent } = fakeApi();
    const deps = depsWith(model, api);
    expect(await announceIn(deps, chat)).toBe("told of 2 new thing(s): alpha, beta");
    expect(model.schemas).toEqual([["alpha", "beta"]]);
    expect(model.prompts[0]).toContain("<first>true</first>");
    expect(sent).toEqual([{ chatId: chat.id, text: "📣 Я кое-чему научился\n\n• <b>ALPHA</b> — про alpha\n• <b>BETA</b> — про beta\n\nЗдорово, правда?" }]);
    const [note] = await notes(chat.id);
    expect(note).toMatchObject({ status: "posted", capabilities: ["alpha", "beta"], ruled_out: [], msg_id: 800_001, attempts: 1 });

    // Once a day at most, and nothing new asks the model nothing.
    expect(await announceIn(deps, chat)).toBeUndefined();
    await dayLater(chat.id);
    expect(await announceIn(deps, chat)).toBeUndefined();
    expect(model.prompts).toHaveLength(1);

    // What ships later is told of the next time, as a follow-up of the earlier post.
    const later = { ...capabilities, gamma: capability("Gamma", "2026-11-24") };
    expect(await announceIn(depsWith(model, api, later), chat)).toBe("told of 1 new thing(s): gamma");
    expect(model.prompts[1]).toContain("<first>false</first>");
    expect(model.prompts[1]).toContain("<earlier_posts>");
    expect(model.prompts[1]).not.toContain("- alpha ·");
  });

  it("posts nothing at night, where an owner turned the notes off, or while the chronicler is paused", async () => {
    const model = fakeModel(every);
    const { api, sent } = fakeApi();
    const deps = depsWith(model, api);
    const chat = await newChat();
    const night = new Date(Date.now() + 12 * 60 * 60_000);
    expect(await announceIn(deps, chat, night)).toBeUndefined();
    // The chat is read afresh: a switch flipped after the round began counts.
    await setAnnouncements(sql, chat.id, false);
    expect(await announceIn(deps, chat)).toBeUndefined();
    await setAnnouncements(sql, chat.id, true);
    await sql`UPDATE chats SET chronicle_paused_at = now() WHERE id = ${chat.id}`;
    expect(await announceIn(deps, chat)).toBeUndefined();
    expect(model.prompts).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("keeps a note the model got wrong as failed, and asks again only the next day", async () => {
    const chat = await newChat();
    const { api, sent } = fakeApi();
    const partial = fakeModel((keys) => ({ ...every(keys), items: every(keys).items.slice(1) }));
    expect(await announceIn(depsWith(partial, api), chat)).toBe("the model's note was unusable: it left out alpha; its news waits for the next day");
    expect(await announceIn(depsWith(partial, api), chat)).toBeUndefined();
    expect(partial.prompts).toHaveLength(1);

    // A wish the model made up is no wish: ruling news out takes a wish of the chat.
    await dayLater(chat.id);
    const unwished = fakeModel((keys) => ({ ...every(keys), items: [], ruled_out: keys }));
    expect(await announceIn(depsWith(unwished, api), chat)).toBe(
      "the model's note was unusable: it ruled out alpha, beta with no wish of the chat to rule them out; its news waits for the next day",
    );
    await dayLater(chat.id);
    expect(await announceIn(depsWith(fakeModel(every), api), chat)).toBe("told of 2 new thing(s): alpha, beta");
    expect(sent).toHaveLength(1);
    expect((await notes(chat.id)).map((note) => note.status)).toEqual(["failed", "failed", "posted"]);
  });

  it("leaves out the news a wish of the chat rules out, and holds the note back when the wish rules out all of it", async () => {
    const chat = await newChat();
    await chatWish(chat, "не пиши в этом чате про альфу");
    const { api, sent } = fakeApi();
    const model = fakeModel((keys) => ({ ...every(keys), items: every(keys).items.filter((item) => item.key !== "alpha"), ruled_out: ["alpha"] }));
    expect(await announceIn(depsWith(model, api), chat)).toBe("told of 1 new thing(s): beta; left out, as a wish of the chat asks: alpha");
    expect(model.prompts[0]).toContain("- «не пиши в этом чате про альфу»");
    expect(model.prompts[0]).not.toContain("Admin");
    expect(sent.map((message) => message.text)).toEqual(["📣 Я кое-чему научился\n\n• <b>BETA</b> — про beta"]);
    await dayLater(chat.id);
    expect(await announceIn(depsWith(model, api), chat)).toBeUndefined();

    const quiet = await newChat();
    await chatWish(quiet, "не публикуй тут никаких анонсов");
    const declined = fakeModel((keys) => ({ intro: "", items: [], ruled_out: keys, outro: "" }));
    expect(await announceIn(depsWith(declined, api), quiet)).toBe("held back a note on alpha, beta: a wish of the chat rules it out");
    await dayLater(quiet.id);
    expect(await announceIn(depsWith(declined, api), quiet)).toBeUndefined();
    expect(declined.prompts).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it("posts a written note again as it is after a passing failure, and only once a day after Telegram refuses it", async () => {
    const chat = await newChat();
    const model = fakeModel(every);
    const flaky = fakeApi([new HttpError("Network request for 'sendMessage' failed!", new Error("socket hang up")), refused(429, "Too Many Requests: retry after 5")]);
    const deps = depsWith(model, flaky.api);
    expect(await announceIn(deps, chat)).toMatch(/^could not post the note yet \(Network request.*\), try 1 of 6$/);
    expect(await announceIn(deps, chat)).toMatch(/^could not post the note yet \(.*Too Many Requests.*\), try 2 of 6$/);
    expect(await announceIn(deps, chat)).toBe("told of 2 new thing(s): alpha, beta");
    expect(model.prompts).toHaveLength(1);
    expect(flaky.sent).toHaveLength(1);

    // Refused for good, a note tells of nothing; the next day the same text goes again, with no new call to the model.
    const other = await newChat();
    const kicked = fakeApi([refused(403, "Forbidden: bot is not a member of the supergroup chat"), refused(403, "Forbidden: bot is not a member of the supergroup chat")]);
    const kickedDeps = depsWith(model, kicked.api);
    expect(await announceIn(kickedDeps, other)).toMatch(/^could not post the note \(.*Forbidden.*\); its news waits for the next day$/);
    expect(await announceIn(kickedDeps, other)).toBeUndefined();
    await dayLater(other.id);
    expect(await announceIn(kickedDeps, other)).toMatch(/^could not post the note \(.*Forbidden.*\)/);
    await dayLater(other.id);
    expect(await announceIn(kickedDeps, other)).toBe("told of 2 new thing(s): alpha, beta");
    expect(model.prompts).toHaveLength(2);
    expect(kicked.sent.map((message) => message.text)).toEqual(["📣 Я кое-чему научился\n\n• <b>ALPHA</b> — про alpha\n• <b>BETA</b> — про beta"]);
    expect((await notes(other.id)).map((note) => note.status)).toEqual(["failed", "failed", "posted"]);
  });

  it("counts a day from when a note went out, so a note delivered late lets no second one out that day", async () => {
    const chat = await newChat();
    const model = fakeModel(every);
    const flaky = fakeApi([new HttpError("Network request for 'sendMessage' failed!", new Error("socket hang up"))]);
    expect(await announceIn(depsWith(model, flaky.api), chat)).toMatch(/^could not post the note yet/);
    await dayLater(chat.id);
    const later = { ...capabilities, gamma: capability("Gamma", "2026-11-24") };
    expect(await announceIn(depsWith(model, flaky.api, later), chat)).toBe("told of 2 new thing(s): alpha, beta");
    expect(await announceIn(depsWith(model, flaky.api, later), chat)).toBeUndefined();
    await dayLater(chat.id);
    expect(await announceIn(depsWith(model, flaky.api, later), chat)).toBe("told of 1 new thing(s): gamma");
  });

  it("never posts a note twice: one found still being sent counts as posted", async () => {
    const chat = await newChat();
    const { api, sent } = fakeApi();
    const written = await writeNote({ sql, anthropic: fakeModel(every).client, config, botUsername: BOT, capabilities }, chat);
    expect(written.kind).toBe("kept");
    await sql`UPDATE announcements SET status = 'sending', attempts = 1 WHERE chat_id = ${chat.id}`;
    expect(await announceIn(depsWith(fakeModel(every), api), chat)).toBe(
      "told of 2 new thing(s): alpha, beta (not known whether Telegram took it: the bot stopped while posting it)",
    );
    expect(sent).toHaveLength(0);
    expect(await announceIn(depsWith(fakeModel(every), api), chat)).toBeUndefined();
  });

  it("keeps a note written while an owner turned the notes off, and posts it once they are on again", async () => {
    const chat = await newChat();
    const { api, sent } = fakeApi();
    const model = fakeModel(every, () => setAnnouncements(sql, chat.id, false));
    expect(await announceIn(depsWith(model, api), chat)).toBe("wrote a note, but the notes were turned off here meanwhile: it waits until they are on again");
    expect(sent).toHaveLength(0);
    await setAnnouncements(sql, chat.id, true);
    expect(await announceIn(depsWith(model, api), chat)).toBe("told of 2 new thing(s): alpha, beta");
    expect(model.prompts).toHaveLength(1);
  });

  it("follows a group that became a supergroup: what it was told stays told, and an owner's off stays off", async () => {
    const group = await newChat(-4000000801);
    const model = fakeModel(every);
    expect(await announceIn(depsWith(model, fakeApi().api), group)).toBe("told of 2 new thing(s): alpha, beta");
    await setAnnouncements(sql, group.id, false);
    await setIdeas(sql, group.id, false);
    await migrateChat(sql, group.id, -1004000000801);
    const upgraded = (await getChat(sql, -1004000000801))!;
    expect(upgraded).toMatchObject({ status: "approved", announcements: false, ideas: false });
    expect((await notes(upgraded.id)).map((note) => note.capabilities)).toEqual([["alpha", "beta"]]);
    // Joined long before the news, as the group was: only what it was told keeps the news from being told again.
    await sql`UPDATE chats SET announcements = true, created_at = '2026-11-09T10:00:00Z' WHERE id = ${upgraded.id}`;
    await dayLater(upgraded.id);
    expect(await announceIn(depsWith(model, fakeApi().api), (await getChat(sql, upgraded.id))!)).toBeUndefined();

    // Telegram may show the bot the supergroup before the move: its own row keeps an owner's off all the same.
    const seenFirst = await newChat(-4000000802);
    await setAnnouncements(sql, seenFirst.id, false);
    await registerChat(sql, -1004000000802, "Hive", null);
    await migrateChat(sql, seenFirst.id, -1004000000802);
    expect(await getChat(sql, -1004000000802)).toMatchObject({ status: "approved", announcements: false });
  });

  it("first looks a while after the start, and stops cleanly", async () => {
    const chat = await newChat();
    const model = fakeModel(every);
    const { api, sent } = fakeApi();
    const lines: string[] = [];
    const stop = startAnnouncements({ ...depsWith(model, api), startDelayMs: 50, everyMs: 60_000, log: (line) => lines.push(line) });
    expect(sent).toHaveLength(0);
    await expect.poll(() => sent.some((message) => message.chatId === chat.id), { timeout: 5000 }).toBe(true);
    await stop();
    expect(lines.some((line) => line.startsWith("[announcements] Hive: told of 2 new thing(s)"))).toBe(true);

    const never = startAnnouncements({ ...depsWith(model, api), startDelayMs: 60_000 });
    await never();
  });
});
