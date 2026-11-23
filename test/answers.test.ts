import type { Message, UserFromGetMe } from "grammy/types";
import { describe, expect, it } from "vitest";
import { replySystemPrompt, squeezedOut } from "../src/bot/assistant.js";
import { emojiOnly, isBanter, reactionTo } from "../src/bot/banter.js";
import { INTERJECTION_SYSTEM_PROMPT } from "../src/bot/interjector.js";
import { calledInOn, catalogHistoryBlock, questionBlock, SHORT_LINE_BLOCK, type Clock } from "../src/bot/reply-context.js";
import { CAPABILITIES, LIMITS } from "../src/core/capabilities.js";
import { answerParts, MAX_CODE_FILE_CHARS, MAX_CODE_FILES, MAX_INLINE_CODE_LINES, overLimits, proseOf } from "../src/core/code-files.js";
import type { CatalogEvent } from "../src/core/projects.js";

const MODELS = ["claude-haiku-5-5", "claude-opus-5-5"];
const me = { id: 4242, is_bot: true, first_name: "Waggle", username: "waggle_test_bot" } as unknown as UserFromGetMe;
const fence = (language: string, lines: number, line = (index: number) => `step(${index})`) =>
  [`\`\`\`${language}`, ...Array.from({ length: lines }, (_, index) => line(index + 1)), "```"].join("\n");
/** What a code block of the message holds, read back by its entity. */
const codeOf = (parts: ReturnType<typeof answerParts>, index = 0) => {
  const entity = parts.entities[index]!;
  return parts.text.slice(entity.offset, entity.offset + entity.length);
};

describe("code in an answer", () => {
  it("keeps a short block in the message as code, without its fences", () => {
    const parts = answerParts("Вот так:\n```python\nprint('hi')\n```\nЗапусти, и готово.");
    expect(parts.text).toBe("Вот так:\nprint('hi')\nЗапусти, и готово.");
    expect(parts.entities).toEqual([{ type: "pre", offset: 9, length: 11, language: "python" }]);
    expect(parts.files).toEqual([]);
    expect(parts.words).toBe("Вот так:\nЗапусти, и готово.");
    expect(parts.unclosed).toBe(false);
  });

  it(`sends code of over ${MAX_INLINE_CODE_LINES} lines as a file named after its language, with a 📎 line where it was`, () => {
    const parts = answerParts(`Скрипт бэкапа:\n\n${fence("python", MAX_INLINE_CODE_LINES + 1)}\n\nЭто фрагмент: вставь его в свой cron.`);
    expect(parts.files).toEqual([{ name: "script.py", content: `${Array.from({ length: MAX_INLINE_CODE_LINES + 1 }, (_, index) => `step(${index + 1})`).join("\n")}\n` }]);
    expect(parts.text).toBe("Скрипт бэкапа:\n\n📎 script.py\n\nЭто фрагмент: вставь его в свой cron.");
    expect(parts.entities).toEqual([]);
    expect(parts.words).not.toContain("step(");
    // A block of exactly a screen stays in the message.
    expect(answerParts(fence("python", MAX_INLINE_CODE_LINES)).files).toEqual([]);
  });

  it("names a file as the answer calls it, when that is a plain name with its language's extension", () => {
    const named = (info: string) => answerParts(fence(info, 30, (index) => `step(${index})`)).files.map((file) => file.name);
    expect(named("python cleanup_logs.py")).toEqual(["cleanup_logs.py"]);
    expect(named("dockerfile Dockerfile")).toEqual(["Dockerfile"]);
    expect(named("python ../etc/passwd")).toEqual(["script.py"]);
    expect(named("python notes.txt")).toEqual(["script.py"]);
    expect(named("python")).toEqual(["script.py"]);
    const twice = answerParts([fence("python main.py", 30, () => "a = 1"), fence("python main.py", 30, () => "b = 2")].join("\n"));
    expect(twice.files.map((file) => file.name)).toEqual(["main.py", "main-2.py"]);
    expect(twice.text).toContain("📎 main.py");
  });

  it("names each file after its language, and a second one of the same language apart", () => {
    const parts = answerParts([fence("swift", 30), fence("Swift", 30), fence("ts", 30), fence("sql", 30), fence("dockerfile", 30)].join("\n"));
    expect(parts.files.map((file) => file.name)).toEqual(["snippet.swift", "snippet-2.swift", "snippet.ts", "query.sql", "Dockerfile"]);
    expect(overLimits(parts)).toBe(parts.files.length > MAX_CODE_FILES);
    expect(parts.text).toBe(["📎 snippet.swift", "📎 snippet-2.swift", "📎 snippet.ts", "📎 query.sql", "📎 Dockerfile"].join("\n"));
  });

  it("never sends words as a file: a block with no language or in text stays in the message and counts as the answer's words", () => {
    const story = fence("", 40, (index) => `Глава ${index}: пчела летела и летела.`);
    const parts = answerParts(`Держи:\n${story}`);
    expect(parts.files).toEqual([]);
    expect(parts.entities).toEqual([{ type: "pre", offset: 7, length: parts.text.length - 7 }]);
    expect(parts.words).toContain("Глава 40");
    // Words fenced as text are shown as words.
    const text = answerParts(fence("text", 40));
    expect(text.words).toContain("step(40)");
    expect(text.entities).toEqual([]);
    expect(answerParts(`Итог:\n${fence("markdown", 2)}`).text).toBe("Итог:\nstep(1)\nstep(2)");
    // A language no file is named after stays in the message as code, so a long one is too long to post.
    const unknown = answerParts(fence("brainfuck", 400, () => "+".repeat(30)));
    expect(unknown.files).toEqual([]);
    expect(unknown.entities[0]).toMatchObject({ language: "brainfuck" });
    expect(overLimits(unknown)).toBe(true);
    for (const language of ["constructor", "toString", "__proto__"]) expect(answerParts(fence(language, 30)).files, language).toEqual([]);
  });

  it("moves the longest code into files while the message would not fit into one, and limits the files", () => {
    const wide = (language: string) => fence(language, 20, (index) => `const line${index} = "${"x".repeat(90)}";`);
    const parts = answerParts(["Три куска:", wide("js"), "и ещё", wide("ts"), "и последний", fence("go", 3)].join("\n"));
    expect(parts.files.map((file) => file.name)).toEqual(["script.js"]);
    expect(parts.text.length).toBeLessThanOrEqual(3900);
    expect(parts.entities.map((entity) => (entity.type === "pre" ? entity.language : undefined))).toEqual(["ts", "go"]);
    expect(overLimits(parts)).toBe(false);
    expect(overLimits(answerParts(fence("python", 300, () => "x = 1  # " + "y".repeat(40))))).toBe(true);
    expect(MAX_CODE_FILE_CHARS).toBeGreaterThan(120 * 50);
  });

  it("places code blocks by UTF-16 offsets, the way Telegram counts, and keeps blank lines single", () => {
    const parts = answerParts("🐝 Код:\r\n\r\n\r\n```js\r\nrun()\r\n```\r\n\r\n\r\nВсё 🌸\n\n");
    expect(parts.text).toBe("🐝 Код:\n\nrun()\n\nВсё 🌸");
    expect(codeOf(parts)).toBe("run()");
    expect(parts.entities[0]!.offset).toBe("🐝 Код:\n\n".length);
  });

  it("holds the words in code to the answer's rules: a story printed by a program is a story, and a word over and over in a string is one", () => {
    /** Whether the answer is what pressure squeezed out of the model, as assistant.ts tells it. */
    const squeezed = (answer: string) => {
      const parts = answerParts(answer);
      return squeezedOut(parts.words) || parts.prose.some(squeezedOut);
    };
    const story = Array.from({ length: 60 }, (_, index) => `Пчела летела над лугом и думала о мёде, день ${index}.`).join(" ");
    expect(squeezed(`Вот программа:\n\`\`\`python\nprint("""${story}""")\n\`\`\``)).toBe(true);
    expect(squeezed(`\`\`\`html\n<html><body><div><p>${story}</p></div></body></html>\n\`\`\``)).toBe(true);
    expect(squeezed(fence("python", 30, (index) => `print("строка ${index}: мяу мяу мяу мяу мяу")`))).toBe(true);
    expect(squeezed(fence("js", 30, (index) => (index === 7 ? `log("мяу мяу мяу мяу мяу")` : `step(${index});`)))).toBe(true);
    // Code itself repeats its words (nested «end», closing tags), and its comments and strings are words of their own.
    const script = [
      "#!/usr/bin/env python3",
      "# Удаляет логи старше заданного числа дней.",
      "import os, sys, time",
      "def clean(path: str, days: int = 7) -> int:",
      '    """Удаляет файлы старше days дней и возвращает, сколько удалено."""',
      "    cutoff = time.time() - days * 86400",
      "    removed = 0",
      "    for name in os.listdir(path):",
      "        full = os.path.join(path, name)  # полный путь",
      "        if os.path.isfile(full) and os.path.getmtime(full) < cutoff:",
      "            os.remove(full)",
      "            removed += 1",
      "    return removed",
      ...Array.from({ length: 20 }, (_, index) => `print("ok")  # шаг ${index}`),
      'if __name__ == "__main__":',
      '    print(f"Удалено: {clean(sys.argv[1])}")',
    ].join("\n");
    expect(squeezed(`Скрипт:\n\`\`\`python\n${script}\n\`\`\`\nЭто фрагмент: вставь его в свой cron.`)).toBe(false);
    expect(squeezed(fence("lua", 12, (index) => (index < 7 ? `${"  ".repeat(index)}if x then` : `${"  ".repeat(12 - index)}end`)))).toBe(false);
    expect(squeezed(fence("html", 30, () => "<div><div><div><div><div>x</div></div></div></div></div>"))).toBe(false);
    // A JSON's keys and values are all strings, and it is still data: a long one goes out as a file.
    const json = ["[", ...Array.from({ length: 60 }, (_, index) => `  {"name": "Member ${index}", "role": "backend developer", "city": "Lisbon"},`), "  {}", "]"].join("\n");
    expect(squeezed(`Пример данных:\n\`\`\`json\n${json}\n\`\`\``)).toBe(false);
    expect(answerParts(`Пример данных:\n\`\`\`json\n${json}\n\`\`\``).files.map((file) => file.name)).toEqual(["data.json"]);
    expect(proseOf(`SELECT name FROM users -- активные\nWHERE note = 'привет мир'`, "sql")).toEqual(["активные", "привет мир"]);
    expect(proseOf(`#include <stdio.h>\nint main() { /* точка входа */ return 0; }`, "c")).toEqual(["точка входа"]);
    expect(proseOf(`<p>Привет, <b>мир</b></p><script>let x = 1;</script>`, "html")).toEqual(["Привет,", "мир"]);
  });

  it("runs a fence left open to the end, and says so", () => {
    const parts = answerParts("Начало:\n```python\nprint(1)\nprint(2)");
    expect(codeOf(parts)).toBe("print(1)\nprint(2)");
    expect(parts.unclosed).toBe(true);
    expect(answerParts("Просто текст, ```без блоков``` внутри").entities).toEqual([]);
  });
});

describe("lines that ask the bot nothing", () => {
  it("tell banter from a question or a task", () => {
    for (const text of [
      "ахаха", "БОТ ТЫ ЛУЧШИЙ", "лол)))", "ну ты и тормоз", "сам такой", "🌸", "ты надоел", "спасибо, ты лучший", "you're a toaster", "lmao",
      "огонь", "ахаха, а ты хорош", "ору", "красава", "😂😂 ну ты даёшь", "Ха-ха", "хехе", "haha nice",
    ]) {
      expect(isBanter(text), text).toBe(true);
    }
    for (const text of [
      "кто прав?", "а ты можешь глянуть мой проект", "напиши скрипт для бэкапа", "посчитай, окупится ли", "объясни, как это работает", "что думаешь про Rust",
      "почему ты такой", "can you check this", "what do you think", "is it live yet", "please be serious", "глянь https://atlas.example", "вот `код`",
      "ну и где обещанный разбор моего проекта, который ты вчера обещал сделать к вечеру", "",
    ]) {
      expect(isBanter(text), text).toBe(false);
    }
  });

  it("take no follow-up to a task, and no line without a sign of banter, for banter", () => {
    for (const text of [
      // Carrying the work on, prefixed verbs and all.
      "давай ещё идей", "подробнее про второй пункт", "продолжай", "а теперь про Кита", "и про Олю", "перепиши на Go", "переделай на async", "упрости",
      "сократи до 20 строк", "давай код", "а теперь с флагом --dry-run", "перепиши, пожалуйста", "ахах, а теперь перепиши на Go", "ты гений, допиши остальное",
      "rewrite it in Go", "now add a --dry-run flag", "go on", "do it again",
      // Asking to take it seriously.
      "отнесись серьёзно", "хватит шутить, это реальная задача", "take it seriously",
      // Nothing that says banter: answered in full.
      "на Go", "короче", "с тестами", "без циклов", "а с async", "разнёс по фактам",
    ]) {
      expect(isBanter(text), text).toBe(false);
    }
    // The examples of a task that the answer rules and the list of what the bot does give.
    const quotes = (text: string) => [...text.matchAll(/«([^»]+)»/g)].map((match) => match[1]!);
    const taskRule = /- A task gets the work, done seriously\.[^\n]*/.exec(replySystemPrompt("claude-opus-5-5"))![0];
    const examples = [...quotes(taskRule.slice(0, taskRule.indexOf("do it for real"))), ...quotes(CAPABILITIES.taskMode.how), ...quotes(CAPABILITIES.codeFiles.how)];
    expect(examples).toEqual(expect.arrayContaining(["изучи проекты и предложи, что реально принесёт доход", "отнесись серьёзно", "хватит шутить, это реальная задача"]));
    for (const example of examples) expect(isBanter(example), example).toBe(false);
  });

  it("tell a message of nothing but emoji, and pick a reaction Telegram lets a bot set, in kind", () => {
    for (const text of ["🌸", "🌹🌹🌹", "😂 😂", "👍🏽", "❤️", "🇷🇺", "👨‍💻"]) expect(emojiOnly(text), text).toBe(true);
    for (const text of ["🌸 спасибо", "❓", "🤔❓", "123", "", ")))", "+"]) expect(emojiOnly(text), text).toBe(false);
    expect(reactionTo("🌸")).toBe("❤");
    expect(reactionTo("💐🌷")).toBe("❤");
    expect(reactionTo("❤️")).toBe("❤");
    expect(reactionTo("😂😂")).toBe("😁");
    expect(reactionTo("🖕")).toBe("🗿");
    expect(reactionTo("🌸🖕")).toBe("🗿");
    expect(reactionTo("😭")).toBe("🤗");
    expect(reactionTo("👍🏽")).toBe("👍");
    expect(reactionTo("🐝")).toBe("👀");
  });
});

describe("a bare mention in reply to a message", () => {
  const from = { id: 7, is_bot: false, first_name: "Bob" };
  const chat = { id: -1, type: "supergroup", title: "Hive" };
  const kits = { message_id: 5, date: 0, chat, from: { id: 8, is_bot: false, first_name: "Kit" }, text: "а кто тут пишет на Rust?" };
  const mention = (extra: Record<string, unknown>) =>
    ({ message_id: 6, date: 0, chat, from, text: "@waggle_test_bot", entities: [{ type: "mention", offset: 0, length: 16 }], ...extra }) as unknown as Message;

  it("calls the bot in on the message it replies to, which is then the question", () => {
    const called = mention({ reply_to_message: kits });
    expect(calledInOn(called, me)).toBe(kits);
    expect(questionBlock({ message: called, from }, kits.text, { author: "Kit", message: kits as unknown as Message })).toBe(
      `<question from="Bob" calls_you_in_on="Kit's message">\nа кто тут пишет на Rust?\n</question>`,
    );
    const photo = { ...kits, text: undefined, photo: [{ file_id: "x", file_unique_id: "x", width: 1, height: 1 }] } as unknown as Message;
    expect(questionBlock({ message: mention({ reply_to_message: photo }), from }, "", { author: "Kit", message: photo })).toBe(
      `<question from="Bob" calls_you_in_on="Kit's message" media="photo">\n\n</question>`,
    );
  });

  it("calls it in on nothing in reply to its own message, with words of its own, or with no reply at all", () => {
    expect(calledInOn(mention({ reply_to_message: { ...kits, from: me } }), me)).toBeUndefined();
    expect(calledInOn(mention({ reply_to_message: kits, text: "@waggle_test_bot а ты что скажешь?" }), me)).toBeUndefined();
    expect(calledInOn(mention({}), me)).toBeUndefined();
    expect(calledInOn(mention({ reply_to_message: { ...kits, from: me }, text: "@waggle_test_bot 🤔" }), me)).toBeUndefined();
  });

  it("takes a mention with nothing but emoji under someone's message as a call too, and tells the model the emoji", () => {
    const called = mention({ reply_to_message: kits, text: "@waggle_test_bot 🤔" });
    expect(calledInOn(called, me)).toBe(kits);
    expect(questionBlock({ message: called, from }, kits.text, { author: "Kit", message: kits as unknown as Message, emoji: "🤔" })).toBe(
      `<question from="Bob" calls_you_in_on="Kit's message" their_emoji="🤔">\nа кто тут пишет на Rust?\n</question>`,
    );
  });
});

describe("the catalog's history in an answer", () => {
  const clock: Clock = { timezone: "UTC", today: "2026-11-23" };
  const at = (day: number) => new Date(Date.UTC(2026, 10, day, 12));
  const event = (fields: Partial<CatalogEvent>): CatalogEvent => ({
    kind: "merge", project_id: 1, project: "Atlas", former: "Atlas Mobile", at: at(18), source: "llm", actor_user_id: null, ...fields,
  });

  it("dates each merge, rename and deletion and says whose it was: the clean-up's, the chronicler's or a member's", () => {
    const names = new Map([[11, "Kit"], [12, "Bob"]]);
    const block = catalogHistoryBlock(
      [
        event({}),
        event({ former: "Atlas Web", at: at(17), source: "user", actor_user_id: 11 }),
        event({ former: "Relic", project: "Nova", at: at(16), source: "admin", actor_user_id: 99 }),
        event({ kind: "delete", project: "Beacon Beta", former: null, at: at(15), source: "user", actor_user_id: 12 }),
        event({ kind: "rename", project: "Beacon", former: "Lighthouse", at: at(14), source: "llm" }),
        event({ kind: "rename", project: "Orbit", former: "Orb", at: at(13), source: "user", actor_user_id: 404 }),
      ],
      names,
      clock,
    );
    expect(block.split("\n").slice(1, -1)).toEqual([
      "- 18 Nov: Atlas Mobile merged into Atlas by the weekly clean-up",
      "- 17 Nov: Atlas Web merged into Atlas by Kit",
      "- 16 Nov: Relic merged into Nova by a bot owner",
      "- 15 Nov: Beacon Beta deleted from the catalog by Bob",
      "- 14 Nov: Lighthouse renamed to Beacon by the chronicler",
      "- 13 Nov: Orb renamed to Orbit by a member",
    ]);
    expect(catalogHistoryBlock([], names, clock)).toBe("");
    // A merge from before the log kept who made it, and not the clean-up's, names nobody.
    expect(catalogHistoryBlock([event({ source: null, actor_user_id: null })], names, clock).split("\n")[1]).toBe(
      "- 18 Nov: Atlas Mobile merged into Atlas by someone other than the clean-up (the log of then does not say who)",
    );
  });
});

describe("the rules an answer keeps", () => {
  it("tell the bot what the catalog's history shows, where merges are done and never to delete a duplicate", () => {
    for (const model of MODELS) {
      const prompt = replySystemPrompt(model);
      for (const rule of [
        "<catalog_history>, when there is one",
        "a duplicate it shows merged was merged",
        "or that nothing happened or nobody did it, when <catalog_history>, <card_change> or the messages show it did",
        "Duplicates are merged by the weekly clean-up, on its own, and in the Mini App",
        "never advise deleting a duplicate",
        "gets one message saying where it is done, or that it is not, and never an invitation to ask you again",
        "never claim you lied or made something up",
      ]) {
        expect(prompt, `${model}: ${rule}`).toContain(rule);
      }
    }
  });

  it("keep a member's side when they defend their work, in the answers and in the uninvited line", () => {
    for (const model of MODELS) {
      const prompt = replySystemPrompt(model);
      for (const rule of ["never side with its critics or say their criticism again", "A callback adds something new, never a second critic", "No jokes about a sore point: their view counts, their slow model, their failed launch"]) {
        expect(prompt, `${model}: ${rule}`).toContain(rule);
      }
    }
    for (const rule of [
      "adds something new: a line that only repeats the conversation, the history, your earlier lines or someone's criticism of a member's work is no line at all",
      "least of all when they defend it or ask for a kinder take",
      "never side with a critic of someone's work",
      "never who people are or a sore point (their view counts, a slow model, a failed launch)",
    ]) {
      expect(INTERJECTION_SYSTEM_PROMPT).toContain(rule);
    }
  });

  it("have code fenced with its language, long code sent as a file, and a fragment said to be one", () => {
    for (const model of MODELS) {
      const prompt = replySystemPrompt(model);
      expect(prompt).toContain("Code is the one thing you put in Markdown: a fenced block with its language (```python … ```), one block a file");
      expect(prompt).toContain(`The bot posts a block of up to ${MAX_INLINE_CODE_LINES} lines as code in your message and sends a longer one as a file: when your words call it by a name, write that name after the language`);
      expect(prompt).toContain("When it is a fragment to fit into their code rather than something that runs as it is, say so in a line");
      expect(prompt).toContain("a task's few concrete points, its code or the outline of a spec are none of these");
    }
    expect(CAPABILITIES.codeFiles.does).toContain(`code of over ${MAX_INLINE_CODE_LINES} lines in your answer goes out as a file, named as your words call it`);
    expect(CAPABILITIES.codeFiles.limits).toContain(`up to ${MAX_CODE_FILES} files`);
    expect(CAPABILITIES.taskMode.limits).toContain("long code goes out as a file");
    expect(LIMITS.sendingFiles).toContain("the long code of an answer as a file beside one");
  });

  it("explain a call-in and a short line, and repeat the side a member's work gets right before the question", () => {
    for (const model of MODELS) {
      const prompt = replySystemPrompt(model);
      expect(prompt).toContain(`calls_you_in_on="…'s message" marks a mention of you in reply to someone's message with nothing else, or with nothing but the emoji in their_emoji="…"`);
      expect(prompt).toContain("<short_line>, when there is one: they have sent you several lines in a row that ask nothing");
      expect(prompt).toContain("If this one does ask for something after all (more of the work, a change to it, a follow-up), do that in full.");
      expect(prompt).toContain("where it says the log does not say who, you don't know either");
    }
    expect(SHORT_LINE_BLOCK).toMatch(/^<short_line>.*one short line.*<\/short_line>$/);
    // Telling banter from a request is a guess, so a short line that does ask for something gets it.
    expect(SHORT_LINE_BLOCK).toContain("but if this one does ask for something after all (more of the work, a change to it, a follow-up), do that in full");
  });
});
