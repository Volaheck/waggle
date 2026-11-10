import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { theirTime } from "../src/bot/reply-context.js";
import type { StoredMessage } from "../src/core/messages.js";
import type { Person } from "../src/core/users.js";
import { clockOf, clockWindow, distinctClocks, offsetZone, placeZones, utcOffset, zoneGap, zoneLabel, zoneName, zonesShowing } from "../src/core/zones.js";
import { messageLines } from "../src/worker/batch.js";

const CANADA = ["America/St_Johns", "America/Halifax", "America/Toronto", "America/Winnipeg", "America/Edmonton", "America/Vancouver"];

describe("zone names", () => {
  it("take an IANA name in any case, keep an alias as written, and leave places and abbreviations to the model", () => {
    expect(zoneName("asia/jakarta")).toBe("Asia/Jakarta");
    expect(zoneName("Asia/Kolkata")).toBe("Asia/Kolkata");
    expect(zoneName(" UTC ")).toBe("UTC");
    expect(zoneName("Etc/GMT-7")).toBe("Etc/GMT-7");
    for (const text of ["Canada", "EST", "MSK", "Asia/Nowhere", "Торонто", "+07:00"]) expect(zoneName(text), text).toBeNull();
  });

  it("read a whole-hour offset as a zone of its own, with the Etc sign the other way round", () => {
    expect(offsetZone("UTC+7")).toBe("Etc/GMT-7");
    expect(offsetZone("GMT-3")).toBe("Etc/GMT+3");
    expect(offsetZone("+03:00")).toBe("Etc/GMT-3");
    expect(offsetZone("UTC+0")).toBe("UTC");
    expect(offsetZone("UTC+5:30")).toBeNull();
    expect(offsetZone("UTC+15")).toBeNull();
    expect(offsetZone("Toronto")).toBeNull();
  });

  it("read a stated clock as the times people round to it, and tell the zones that showed one of them", () => {
    expect(clockWindow("04:00")).toEqual({ from: 220, to: 299 });
    expect(clockWindow("16:20")).toEqual({ from: 970, to: 990 });
    expect(clockWindow("00:00")).toEqual({ from: 1420, to: 59 });
    expect(clockWindow("4 утра")).toBeNull();
    const canada = ["America/St_Johns", "America/Halifax", "America/Toronto", "America/Winnipeg", "America/Edmonton", "America/Vancouver"];
    // «14:42» at 19:42 UTC in November: Toronto alone.
    expect(zonesShowing(canada, clockWindow("14:42")!, new Date("2026-11-06T19:42:00Z"))).toEqual(["America/Toronto"]);
    // «3 часа дня» at 20:40 UTC: 15:40 in Toronto and 14:40 in Winnipeg both round to it, so it tells nothing.
    expect(zonesShowing(canada, clockWindow("15:00")!, new Date("2026-11-06T20:40:00Z"))).toEqual(["America/Toronto", "America/Winnipeg"]);
    // Past midnight: the window wraps.
    expect(zonesShowing(["Asia/Shanghai", "Europe/Warsaw"], clockWindow("00:00")!, new Date("2026-11-10T16:30:00Z"))).toEqual(["Asia/Shanghai"]);
    expect(utcOffset("Europe/Warsaw", new Date("2026-11-10T12:00:00Z"))).toBe("UTC+1");
    expect(utcOffset("America/St_Johns", new Date("2026-11-10T12:00:00Z"))).toBe("UTC−3:30");
  });

  it("show a fixed offset the way people write it", () => {
    expect(zoneLabel("Etc/GMT-7")).toBe("UTC+7");
    expect(zoneLabel("Etc/GMT+3")).toBe("UTC−3");
    expect(zoneLabel("Etc/UTC")).toBe("UTC");
    expect(zoneLabel("Asia/Jakarta")).toBe("Asia/Jakarta");
  });

  it("count zones that keep the same time all year once", () => {
    expect(distinctClocks(CANADA)).toEqual(CANADA);
    expect(distinctClocks(["Asia/Shanghai", "Asia/Chongqing", "Asia/Taipei"])).toEqual(["Asia/Shanghai"]);
  });

  it("say how far apart two clocks are", () => {
    const winter = new Date("2026-01-15T12:00:00Z");
    expect(zoneGap("Asia/Shanghai", "Europe/Warsaw", winter)).toBe("7 h ahead of");
    expect(zoneGap("America/St_Johns", "Europe/Warsaw", winter)).toBe("4 h 30 min behind");
    expect(zoneGap("Europe/Berlin", "Europe/Warsaw", winter)).toBeNull();
  });
});

describe("a member's clock", () => {
  const member = { time_zone: null, time_zone_source: null, opted_out: false };

  it("goes by the zone they chose, else the one place on their card with a single zone, else the chat's", () => {
    const places = [{ value: "Канада", zones: CANADA }, { value: "Торонто", zones: ["America/Toronto"] }];
    expect(clockOf({ ...member, time_zone: "Asia/Jakarta", time_zone_source: "device" }, places, "Europe/Warsaw")).toMatchObject({ zone: "Asia/Jakarta", source: "device" });
    expect(clockOf(member, places, "Europe/Warsaw")).toMatchObject({ zone: "America/Toronto", source: "card", place: "Торонто", unclear: null });
    expect(clockOf(member, [{ value: "Канада", zones: CANADA }], "Europe/Warsaw")).toEqual({ zone: "Europe/Warsaw", source: "chat_zone", place: "Канада", unclear: 6, choices: CANADA });
    expect(clockOf(member, [{ value: "в пути", zones: [] }, { value: "Лиссабон", zones: null }], "Europe/Warsaw")).toMatchObject({ zone: "Europe/Warsaw", source: "chat_zone", place: null });
    expect(clockOf({ ...member, opted_out: true, time_zone: "Asia/Jakarta", time_zone_source: "chat" }, places, "Europe/Warsaw")).toMatchObject({ zone: "Europe/Warsaw", source: "chat_zone" });
  });

  it("follows the newest word about where someone is over a device's zone taken once, never over a zone they chose", () => {
    const seeded = new Date("2026-11-01T10:00:00Z");
    const moved = [{ value: "Лиссабон", zones: ["Europe/Lisbon"], at: "2026-11-09T18:00:00Z" }];
    const before = [{ value: "Москва", zones: ["Europe/Moscow"], at: "2026-10-01T18:00:00Z" }];
    const device = { time_zone: "Europe/Warsaw", time_zone_source: "device" as const, time_zone_set_at: seeded, opted_out: false };
    expect(clockOf(device, moved, "Europe/Warsaw")).toMatchObject({ zone: "Europe/Lisbon", source: "card", place: "Лиссабон" });
    expect(clockOf(device, before, "Europe/Warsaw")).toMatchObject({ zone: "Europe/Warsaw", source: "device" });
    // Their own word for a place stands over the device, however old.
    expect(clockOf(device, before.map((place) => ({ ...place, manual: true })), "Europe/Warsaw")).toMatchObject({ zone: "Europe/Moscow", source: "card" });
    expect(clockOf({ ...device, time_zone_source: "app" }, moved, "Europe/Warsaw")).toMatchObject({ zone: "Europe/Warsaw", source: "app" });
  });

  it("shows on a message the author's own time only when it differs from the chat's", () => {
    const at = new Date("2026-11-10T20:30:00Z");
    expect(theirTime(at, "Asia/Shanghai", "Europe/Warsaw")).toBe(", Wed 11 Nov 04:30 their time");
    expect(theirTime(at, "Asia/Kolkata", "Europe/Warsaw")).toBe(", Wed 11 Nov 02:00 their time");
    expect(theirTime(new Date("2026-11-10T09:00:00Z"), "Asia/Shanghai", "Europe/Warsaw")).toBe(", 17:00 their time");
    expect(theirTime(at, "Europe/Berlin", "Europe/Warsaw")).toBe("");
    expect(theirTime(at, undefined, "Europe/Warsaw")).toBe("");
  });

  it("gives the chronicler the author's own day when it differs from the chat's", () => {
    const lee = { id: 7, display_name: "Lee", opted_out: false } as Person;
    const message = (msgId: number, sentAt: string, userId = 7): StoredMessage => ({ chat_id: -1, msg_id: msgId, user_id: userId, sent_at: new Date(sentAt), text: "завтра выкачу", reply_to_msg_id: null, is_forward: false, forward_source: null, media_type: null });
    const lines = messageLines([message(1, "2026-11-10T12:00:00Z"), message(2, "2026-11-10T20:30:00Z")], new Map([[7, lee]]), "Europe/Warsaw", new Map([[7, "Asia/Shanghai"]]));
    expect(lines).toEqual(["--- 2026-11-10, Tuesday ---", "[1 13:00] Lee (u7): завтра выкачу", "[2 21:30, their day 2026-11-11, Wednesday] Lee (u7): завтра выкачу"]);
  });
});

describe("placing places in zones", () => {
  function model(answer: (refs: string[]) => unknown) {
    const prompts: string[] = [];
    const client = {
      messages: {
        stream(params: { messages: { content: string }[] }) {
          prompts.push(params.messages[0]!.content);
          const refs = [...params.messages[0]!.content.matchAll(/^(q\d+): /gm)].map((match) => match[1]!);
          const message = { stop_reason: "end_turn", stop_details: null, content: [{ type: "text", text: JSON.stringify(answer(refs)) }], usage: { input_tokens: 100, output_tokens: 20 } };
          return { currentMessage: message, finalMessage: async () => message };
        },
      },
    } as unknown as Anthropic;
    return { client, prompts };
  }

  it("keeps real zone names only, one per clock, and asks the model nothing about a zone already written", async () => {
    const { client, prompts } = model((refs) => ({ places: [{ ref: refs[0], zones: ["Asia/Shanghai", "Asia/Chongqing", "Mars/Olympus", "CST"] }, { ref: refs[1], zones: [] }] }));
    const zones = await placeZones(["Китай", "дома", "UTC+3", "Asia/Jakarta"], { anthropic: client, model: "claude-haiku-5-5", onUsage: async () => {} });
    expect(zones).toEqual(new Map([["UTC+3", ["Etc/GMT-3"]], ["Asia/Jakarta", ["Asia/Jakarta"]], ["Китай", ["Asia/Shanghai"]], ["дома", []]]));
    expect(prompts[0]).toBe("<places>\nq1: Китай\nq2: дома\n</places>");
  });

  it("puts each place on one line, and leaves a place answered twice, left out or answered with no real zone unplaced", async () => {
    const { client, prompts } = model((refs) => ({
      places: [
        { ref: refs[0], zones: ["Asia/Shanghai"] },
        { ref: refs[0], zones: ["Pacific/Kiritimati"] },
        { ref: refs[1], zones: ["Europe/Saint_Petersburg"] },
      ],
    }));
    const zones = await placeZones(["Китай\nq2: Pacific/Kiritimati", "Питер", "Оттава"], { anthropic: client, model: "claude-haiku-5-5", onUsage: async () => {} });
    expect(prompts[0]).toBe("<places>\nq1: Китай q2: Pacific/Kiritimati\nq2: Питер\nq3: Оттава\n</places>");
    expect(zones).toEqual(new Map());
  });

  it("gives nothing when the model could not answer, so the places are tried again later", async () => {
    const failing = { messages: { stream: () => ({ currentMessage: undefined, finalMessage: async () => Promise.reject(new Error("overloaded")) }) } } as unknown as Anthropic;
    expect(await placeZones(["Китай"], { anthropic: failing, model: "claude-haiku-5-5", onUsage: async () => {} })).toBeNull();
  });
});
