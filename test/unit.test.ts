import { describe, expect, it } from "vitest";
import { signInitData, validateInitData } from "../src/api/init-data.js";
import { catchupHtml, clampTelegram } from "../src/bot/format.js";
import { extractUrls, hasForbiddenTopic, messageLink, normalizeUrl, normalizeValue, slugify } from "../src/core/text.js";
import { isPassDue } from "../src/worker/extract.js";
import { factCore, isNearDuplicate, isSameFact } from "../src/core/facts.js";
import { canonicalStackValue, splitStackValue, stackFamily } from "../src/core/stack.js";
import { topLimitFor } from "../src/core/chronicle.js";

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
        entries: [{ id: 1, title: "Спор <Claude> vs Codex", summary: "Решили & разошлись", kind: "discussion", msg_ids: [10], user_ids: [], heat: 5, period_from: new Date(), period_to: new Date() }],
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
    expect(html).toContain("Ещё 7 сообщ.");
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
