import { describe, expect, it } from "vitest";
import { signInitData, validateInitData } from "../src/api/init-data.js";
import { catchupHtml, clampTelegram } from "../src/bot/format.js";
import { extractUrls, hasForbiddenTopic, messageLink, nameKey, normalizeUrl, normalizeValue, slugify, truncate } from "../src/core/text.js";
import { rankCards } from "../src/core/merge.js";
import { assistantNote, replyEffort, replySystemPrompt } from "../src/bot/assistant.js";
import { buildExtractionPrompt, EXTRACTION_SYSTEM_PROMPT, isPassDue } from "../src/worker/extract.js";
import { CONSOLIDATION_SYSTEM_PROMPT } from "../src/worker/consolidate.js";
import { factCore, isNearDuplicate, isSameFact } from "../src/core/facts.js";
import { detectLanguage } from "../src/core/language.js";
import { maskPersonalData } from "../src/core/privacy.js";
import { PROJECT_STATUSES } from "../src/core/projects.js";
import { canonicalStackValue, splitStackValue, stackFamily } from "../src/core/stack.js";
import { topLimitFor } from "../src/core/chronicle.js";
import type { StoredMessage } from "../src/core/messages.js";
import type { Person } from "../src/core/users.js";

const TOKEN = "123456:TEST-TOKEN";

describe("validateInitData", () => {
  const now = 1_800_000_000;
  const fields = { auth_date: String(now - 60), query_id: "AAA", user: JSON.stringify({ id: 42, first_name: "Аня", username: "anna" }) };

  it("accepts correctly signed data", () => {
    const result = validateInitData(signInitData(fields, TOKEN), TOKEN, now);
    expect(result?.user).toMatchObject({ id: 42, first_name: "Аня", username: "anna" });
  });

  it("rejects tampered data", () => {
    const tampered = signInitData(fields, TOKEN).replace("anna", "hacker");
    expect(validateInitData(tampered, TOKEN, now)).toBeNull();
  });

  it("rejects another bot's signature", () => {
    expect(validateInitData(signInitData(fields, "999:OTHER"), TOKEN, now)).toBeNull();
  });

  it("rejects stale data", () => {
    expect(validateInitData(signInitData(fields, TOKEN), TOKEN, now + 2 * 86_400)).toBeNull();
  });
});

describe("text helpers", () => {
  it("normalizes values for dedupe", () => {
    expect(normalizeValue("  Ёлка, «Rust»! ")).toBe("елка rust");
  });

  it("compares names the way people see them, whichever keyboard or font wrote them", () => {
    expect(nameKey("Тор")).toBe(nameKey("Top"));
    expect(nameKey("ТОР")).toBe(nameKey("top"));
    expect(nameKey("MAESTRO (THE ONE AND ONLY)")).toBe("maestro the one and only");
    expect(nameKey("𝐌𝐚𝐞𝐬𝐭𝐫𝐨 🐝")).toBe("maestro");
    expect(nameKey("Ника / Nick K.")).not.toBe(nameKey("Ника"));
    expect(nameKey("Арсений")).not.toBe(nameKey("Арсен"));
    for (const [a, b] of [["тор", "Тор"], ["миша", "Миша"], ["АННА", "Анна"], ["вера", "ВЕРА"]] as const) expect(nameKey(a), a).toBe(nameKey(b));
    expect(nameKey("🦊")).toBe("");
  });

  it("never cuts an emoji in half", () => {
    const cut = truncate("Константин Константинопольский 🐝 dev", 31);
    expect(cut.endsWith("…")).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut)).toBe(false);
    expect(truncate("short", 31)).toBe("short");
  });

  it("puts the card a newcomer's name points to first, and keeps the rest in their order", () => {
    const cards = [{ display_name: "Kit" }, { display_name: "Тор" }, { display_name: "Maestro" }, { display_name: "Oscar the Owl" }];
    const maestro = rankCards(cards, { display_name: "MAESTRO (THE ONE AND ONLY)", username: "night_owl_42" });
    expect(maestro.map((card) => [card.display_name, card.match])).toEqual([["Maestro", "part"], ["Kit", "none"], ["Тор", "none"], ["Oscar the Owl", "none"]]);
    expect(rankCards(cards, { display_name: "Top", username: null })[0]).toMatchObject({ display_name: "Тор", match: "same" });
    expect(rankCards(cards, { display_name: "Max", username: "oscar" })[0]).toMatchObject({ display_name: "Oscar the Owl", match: "part" });
    expect(rankCards(cards, { display_name: "Gleb [Pumpkin]", username: "Pumpkin" }).every((card) => card.match === "none")).toBe(true);
  });

  it("blocks forbidden topics but not lookalike tech words", () => {
    expect(hasForbiddenTopic("взгляды на политику")).toBe(true);
    expect(hasForbiddenTopic("зарплата 5000")).toBe(true);
    expect(hasForbiddenTopic("фронтенд на React")).toBe(false);
    expect(hasForbiddenTopic("Swift, Rust")).toBe(false);
    expect(hasForbiddenTopic("свой аналог Stremio")).toBe(false);
    expect(hasForbiddenTopic("долгие задачи с ИИ-агентами")).toBe(false);
    expect(hasForbiddenTopic("взял в долг")).toBe(true);
    expect(hasForbiddenTopic("налоги в Польше")).toBe(true);
  });

  it("blocks the same topics in English, but not lookalike tech words", () => {
    for (const value of ["Mike talked about his salary", "got divorced", "therapy", "Putin", "Trump's tariffs", "taxes in Poland", "my wife", "political views", "war in Ukraine"]) {
      expect(hasForbiddenTopic(value), value).toBe(true);
    }
    for (const value of ["taxi app", "trumpet", "software warnings", "award-winning", "taxonomy", "incoming webhook", "health check endpoint", "network diagnostics", "screen orientation", "dating app", "IP address", "tech debt"]) {
      expect(hasForbiddenTopic(value), value).toBe(false);
    }
  });

  it("lets a project's money-making through, but never amounts of money", () => {
    for (const value of ["Анна зарабатывает на своих приложениях в сторе", "приложение уже приносит доход", "the app brings some income", "first paying users"]) {
      expect(hasForbiddenTopic(value), value).toBe(false);
    }
    for (const value of ["потратил 500 долларов", "доход 50к рублей", "заработал $300", "€20 в месяц", "3 млн ₽", "spent 500 dollars", "made 200 USD"]) {
      expect(hasForbiddenTopic(value), value).toBe(true);
    }
    for (const value of ["3 рубрики", "5 europeans", "версия 0.4", "в 2 раза быстрее", "150 агентов"]) {
      expect(hasForbiddenTopic(value), value).toBe(false);
    }
  });

  it("extracts and normalizes urls", () => {
    expect(extractUrls("смотри https://github.com/example/atlas, и https://atlas.example.app/.")).toEqual(["https://github.com/example/atlas", "https://atlas.example.app/"]);
    expect(normalizeUrl("https://www.GitHub.com/x/y/?utm_source=tg")).toEqual({ norm: "github.com/x/y", domain: "github.com" });
  });

  it("builds private supergroup message links", () => {
    expect(messageLink(-1001234567890, 55)).toBe("https://t.me/c/1234567890/55");
  });

  it("slugifies cyrillic names", () => {
    expect(slugify("Календарь для Android")).toBe("kalendar-dlya-android");
  });
});

describe("isPassDue", () => {
  const hour = 3_600_000;
  const now = new Date("2026-11-10T12:00:00Z");

  it("waits for the interval since the last pass regardless of message count", () => {
    const pending = { count: 500, oldest: new Date(now.getTime() - 10 * hour) };
    expect(isPassDue(pending, new Date(now.getTime() - 2 * hour), 6, now)).toBe(false);
    expect(isPassDue(pending, new Date(now.getTime() - 6 * hour), 6, now)).toBe(true);
  });

  it("runs even for a single pending message once the interval passed", () => {
    expect(isPassDue({ count: 1, oldest: new Date(now.getTime() - hour) }, new Date(now.getTime() - 7 * hour), 6, now)).toBe(true);
  });

  it("does nothing without pending messages", () => {
    expect(isPassDue({ count: 0, oldest: null }, null, 6, now)).toBe(false);
  });

  it("first pass waits for the interval since the oldest pending message", () => {
    expect(isPassDue({ count: 3, oldest: new Date(now.getTime() - 2 * hour) }, null, 6, now)).toBe(false);
    expect(isPassDue({ count: 3, oldest: new Date(now.getTime() - 7 * hour) }, null, 6, now)).toBe(true);
  });
});

describe("telegram formatting", () => {
  it("clamps long html on a line boundary", () => {
    const html = Array.from({ length: 200 }, (_, i) => `<b>строка ${i}</b>`).join("\n");
    const clamped = clampTelegram(html, 500);
    expect(clamped.length).toBeLessThanOrEqual(502);
    expect(clamped.endsWith("…")).toBe(true);
    expect(clamped.split("<b>").length).toBe(clamped.split("</b>").length);
  });

  it("renders catchup with pending tail and escapes html", () => {
    const html = catchupHtml(
      {
        from: new Date("2026-11-10T08:00:00Z"),
        entries: [{ id: 1, title: "Спор <Claude> vs Codex", summary: "Решили & разошлись", kind: "discussion", importance: 3, msg_ids: [10], user_ids: [], heat: 5, period_from: new Date(), period_to: new Date() }],
        totalMessages: 42,
        unprocessed: { count: 7, firstMsgId: 99 },
        lastRunAt: null,
        mentions: [],
      },
      new Map(),
      -1001,
      6,
      "UTC",
    );
    expect(html).toContain("&lt;Claude&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("7 more messages not chronicled yet");
    expect(html).toContain("https://t.me/c/1/99");
  });
});

describe("fact dedupe", () => {
  it("finds the core of a fact", () => {
    expect(factCore("Codex (тариф Max)")).toBe("codex");
    expect(factCore("Minecraft: моды, сборки")).toBe("minecraft");
    expect(factCore("Claude — для фронта")).toBe("claude");
  });

  it("treats rewordings as duplicates but keeps different tools apart", () => {
    expect(isNearDuplicate("Codex (тариф Max)", "Codex (активно пользовался)")).toBe(true);
    expect(isNearDuplicate("MacBook Pro M5 Pro 64 ГБ", "MacBook с чипом M5 Pro")).toBe(true);
    expect(isNearDuplicate("Minecraft: моды", "Minecraft (свой сервер)")).toBe(true);
    expect(isNearDuplicate("Claude", "Claude Code")).toBe(false);
    expect(isNearDuplicate("Rust", "Swift")).toBe(false);
  });
});

describe("chronicle digest size", () => {
  it("shows a handful of top events per period", () => {
    expect([1, 3, 7, 30].map(topLimitFor)).toEqual([5, 7, 10, 15]);
  });
});

describe("stack families", () => {
  it("folds one vendor's tools into one fact", () => {
    for (const value of ["GPT-6", "GPT Astra", "ChatGPT", "Codex", "Codex (тариф Max)", "GPT 5.6 Sol"]) expect(canonicalStackValue(value)).toBe("GPT / Codex");
    for (const value of ["Claude Opus", "Claude Code", "Claude Design", "Sonnet"]) expect(canonicalStackValue(value)).toBe("Claude");
    expect(isSameFact("stack", "GPT-6", "Codex")).toBe(true);
    expect(isSameFact("stack", "Claude", "Codex")).toBe(false);
    expect(isSameFact("stack", "Rust", "Swift")).toBe(false);
  });

  it("judges the family by the tool itself, not the clarification", () => {
    expect(stackFamily("Claude Code (вместе с Codex)")?.key).toBe("anthropic");
    expect(stackFamily("Codex (в паре с Claude)")?.key).toBe("openai");
  });

  it("splits combined facts into separate tools", () => {
    expect(splitStackValue("Gemini, ChatGPT")).toEqual(["Gemini", "ChatGPT"]);
    expect(splitStackValue("Vercel, Scaleway")).toEqual(["Vercel", "Scaleway"]);
    expect(splitStackValue("GPT / Codex")).toEqual(["GPT / Codex"]);
    expect(splitStackValue("Rust")).toEqual(["Rust"]);
  });
});

describe("chronicler prompts", () => {
  // Even one Russian word in the instructions made the model write an English chat's content in Russian.
  const cyrillic = /\p{Script=Cyrillic}/u;

  it("are written in English and list the exact status codes the schemas accept", () => {
    for (const prompt of [EXTRACTION_SYSTEM_PROMPT, CONSOLIDATION_SYSTEM_PROMPT]) {
      for (const code of PROJECT_STATUSES) expect(prompt).toContain(`"${code}"`);
      expect(prompt).not.toMatch(cyrillic);
    }
  });

  it("tell the model the chat's language when it can be measured", () => {
    const person: Person = { id: 7, tg_id: 7, username: null, display_name: "Ann", is_admin: false, dm_started: false, current_chat_id: null, chat_id: -1, user_id: 7, tagline: null, tagline_manual: false, opted_out: false, first_seen_at: null, last_message_at: null, left_at: null };
    const message = (msgId: number, text: string, isForward = false): StoredMessage => ({ chat_id: -1, msg_id: msgId, user_id: 7, sent_at: new Date(), text, reply_to_msg_id: null, is_forward: isForward, forward_source: null, media_type: null });
    const build = (batch: StoredMessage[]) => buildExtractionPrompt({ chatId: -1, batch, context: [], users: [person], facts: [], projects: [] });
    const english = build([message(1, "Shipped the new version of my habit tracker tonight, and it is so much faster than the old one")]);
    expect(english.startsWith("<chat_language>English</chat_language>")).toBe(true);
    expect(english).not.toMatch(cyrillic);
    // A forwarded post says nothing about the chat's language.
    const russian = build([message(1, "Выкатила новую версию трекера привычек, работает намного быстрее старой"), message(2, "Breaking news from the tech world: a long English article about something", true)]);
    expect(russian.startsWith("<chat_language>Russian</chat_language>")).toBe(true);
    expect(build([message(1, "ok")])).not.toContain("<chat_language>");
  });

  it("keep an English chat's prompt free of words in other languages", () => {
    const mike: Person = { id: 7, tg_id: 7, username: "mike", display_name: "Mike", is_admin: false, dm_started: false, current_chat_id: null, chat_id: -1, user_id: 7, tagline: null, tagline_manual: false, opted_out: false, first_seen_at: null, last_message_at: null, left_at: null };
    const forward: StoredMessage = { chat_id: -1, msg_id: 2, user_id: 7, sent_at: new Date(), text: "Look at this", reply_to_msg_id: 1, is_forward: true, forward_source: "Tech News", media_type: "photo" };
    const prompt = buildExtractionPrompt({
      chatId: -1,
      batch: [forward, { ...forward, msg_id: 3, user_id: null, reply_to_msg_id: null, is_forward: false, forward_source: null, media_type: null }],
      context: [],
      users: [mike, { ...mike, id: 8, user_id: 8, opted_out: true }],
      facts: [],
      projects: [{ slug: "atlas", name: "Atlas", status: PROJECT_STATUSES[0], authors: ["u7"] }],
    });
    expect(prompt).toContain("u7 | Mike (@mike) | no tagline");
    expect(prompt).toContain("atlas | Atlas | idea | authors: u7");
    expect(prompt).toContain("These members asked that nothing be collected about them (do not write facts or taglines about them): u8");
    expect(prompt).toContain("[2] Mike (u7) ↩1 [forwarded from Tech News] [photo]: Look at this");
    expect(prompt).toContain("[3] unknown: Look at this");
    expect(prompt).not.toMatch(cyrillic);
  });

  it("show a message without text by what it was, with no empty text after it", () => {
    const mike: Person = { id: 7, tg_id: 7, username: "mike", display_name: "Mike", is_admin: false, dm_started: false, current_chat_id: null, chat_id: -1, user_id: 7, tagline: null, tagline_manual: false, opted_out: false, first_seen_at: null, last_message_at: null, left_at: null };
    const photo: StoredMessage = { chat_id: -1, msg_id: 4, user_id: 7, sent_at: new Date(), text: "", reply_to_msg_id: null, is_forward: false, forward_source: null, media_type: "photo" };
    const prompt = buildExtractionPrompt({ chatId: -1, batch: [photo, { ...photo, msg_id: 5, text: "Nice shot", media_type: null, reply_to_msg_id: 4 }], context: [], users: [mike], facts: [], projects: [] });
    expect(prompt).toContain("[4] Mike (u7) [photo]\n");
    expect(prompt).toContain("[5] Mike (u7) ↩4: Nice shot");
  });
});

describe("chat language detection", () => {
  it("names the language of the members' messages", () => {
    expect(detectLanguage(["Привет! Кто-нибудь уже пробовал новый Claude Code? Мне интересно, как он работает с большими проектами"])).toBe("Russian");
    expect(detectLanguage(["Привіт! Хтось уже пробував новий редактор? Мені цікаво, як він працює з великими проєктами"])).toBe("Ukrainian");
    expect(detectLanguage(["Has anyone tried the new editor yet? I want to know how it works with big projects"])).toBe("English");
    expect(detectLanguage(["¿Alguien ya probó el nuevo editor? Quiero saber cómo funciona con proyectos grandes y también con los pequeños"])).toBe("Spanish");
  });

  it("stays silent when the text is too short or too mixed, and uses fallbacks only when needed", () => {
    expect(detectLanguage(["ok", "👍"])).toBeNull();
    expect(detectLanguage(["Shipped it today, works great with the new sync", "Выкатил сегодня, отлично работает с новой синхронизацией"])).toBeNull();
    expect(detectLanguage(["ok"], ["фронтенд-разработчик", "скайдайвинг и путешествия", "Летопись чата: релиз нового бота"])).toBe("Russian");
  });
});

describe("masking personal data before a prompt", () => {
  it("masks phones, emails, cards, accounts, long numbers and secrets", () => {
    const cases: [string, string][] = [
      ["Звони +7 (912) 345-67-89 или 8 912 345 67 89", "Звони [phone] или [phone]"],
      ["call +1-202-555-0143 or +31 6 12345678", "call [phone] or [phone]"],
      ["тел:+79123456789, wa.me/79123456789, https://wa.me/79123456789.", "тел:[phone], [phone], [phone]."],
      ["пиши на ivan.petrov@gmail.com", "пиши на [email]"],
      ["карта 4111 1111 1111 1111, другая 4111-1111-1111-1112", "карта [card], другая [number]"],
      ["IBAN GB82 WEST 1234 5698 7654 32", "IBAN [account]"],
      ["паспорт 4508 123456, ИНН 7707083893, счёт 40817810099910004312", "паспорт [number], ИНН [number], счёт [number]"],
      ["ключ sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx-yz", "ключ [secret]"],
      ["токен 1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1 вот", "токен [secret] вот"],
      ["тел.89123456789, т.8(912)345-67-89", "тел.[phone], т.[phone]"],
      ["TON UQBvW8Z5huBkMJYdnfAEM5JqTNkuWX3diqYENkWsIL0XggGG, ETH 0x52908400098527886E0F7030069857D2E4169EE7", "TON [account], ETH [account]"],
      ["BTC 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa и TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC", "BTC [account] и [account]"],
      ["https://api.telegram.org/bot1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1/getMe", "https://api.telegram.org/bot[secret]/getMe"],
      ["https://user:hunter2@db.example.com/admin", "https://user:[email]/admin"],
      ["password: hunter2abc, API_KEY=abc123def456ghi. пароль: qwerty123!", "password: [secret], API_KEY=[secret]. пароль: [secret]!"],
      ["AIzaSyD-1234567890abcdefghijklmnopqrstu", "[secret]"],
      ["-----BEGIN OPENSSH PRIVATE KEY----- b3BlbnNzaC1rZXktdjEAAAAA -----END OPENSSH PRIVATE KEY----- ок", "[secret] ок"],
      ["тел-89161234567, ИНН-770708389312, счёт-40817810099910004312", "тел-[phone], ИНН-[number], счёт-[number]"],
      ["card-4111 1111 1111 1111 и WhatsApp-79161234567", "card-[card] и WhatsApp-[phone]"],
      ["пробили: Иванов Пётр Сергеевич 03.04.1990, телефон 79161234567", "пробили: [person], телефон [phone]"],
      ["дата рождения: 03.04.1990, д.р. 3.4.1990", "дата рождения: [birthdate], д.р. [birthdate]"],
    ];
    for (const [text, masked] of cases) expect(maskPersonalData(text)).toBe(masked);
  });

  it("leaves dates, times, versions, prices, years, short numbers, usernames and links alone", () => {
    for (const text of [
      "Встреча 09.11.2026 в 10:30, версия 1.2.3, цена 1 500 ₽, $2,000,000, 3,14",
      "Годы 2019-2024 и 2023 2024 2025, 1500 подписчиков, id 262479306",
      "Пиши @flyheck, репо https://github.com/Volaheck/waggle и https://t.me/c/1581413930/168194",
      "Наша группа https://t.me/+5bX9kLmN2pQrStUv и чат по номеру не публикуем",
      "Релиз 2026-11-20 18:00, лог 2026-11-09 10:36:05, считаем 1 2 3 4 5 6 7 8 9 10, бюджет 15 000 000 000",
      "Главный ключ: JavaScript и TypeScript, token: Ethereum, хэштег 3dprintingenthusiastsforever",
      "Даниил Константинович написал 09.11.2026, встреча Иван Петров 10.11.2026",
      "https://medium.com/@author/post, v1.2.3, 3.14159265358979, 10.0.19045.1234, claude-sonnet-4-5-20250929, claude-3-5-sonnet-20241022",
    ]) {
      expect(maskPersonalData(text)).toBe(text);
    }
  });

  it("stays fast on the longest Telegram message, whatever is in it", () => {
    for (const text of ["ж".repeat(4096), "1 ".repeat(2048), "a@".repeat(2048), "a.".repeat(2048) + "@b", "QUJD".repeat(1024)]) {
      const started = performance.now();
      maskPersonalData(text);
      expect(performance.now() - started).toBeLessThan(50);
    }
  });
});

describe("answer prompt", () => {
  it("has only the larger models weigh several angles first, and runs Opus at the effort it was tested with", () => {
    expect(replySystemPrompt("claude-haiku-5-5")).not.toContain("draft three different angles");
    expect(replySystemPrompt("claude-sonnet-5-5")).toContain("draft three different angles");
    expect(replySystemPrompt("claude-opus-5-5")).toContain("draft three different angles");
    for (const model of ["claude-haiku-5-5", "claude-opus-5-5"]) {
      expect(replySystemPrompt(model)).toContain("never in stock motifs");
      expect(replySystemPrompt(model)).not.toContain("${");
    }
    expect([replyEffort("claude-haiku-5-5"), replyEffort("claude-sonnet-5-5"), replyEffort("claude-opus-5-5")]).toEqual(["high", "high", "medium"]);
  });

  it("speaks Russian in a Russian-speaking chat and English anywhere else", () => {
    expect(assistantNote("Russian", "memberBusy")).toContain("передышка");
    expect(assistantNote("English", "memberBusy")).toContain("breather");
    expect(assistantNote(null, "refused")).toBe("🐝 I'll pass on this one.");
    expect(assistantNote("Ukrainian", "busy")).toContain("ask me again");
  });
});
