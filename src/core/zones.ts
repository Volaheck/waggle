import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Queryable, Sql } from "./db.js";
import { MIN_VISIBLE_CONFIDENCE } from "./facts.js";
import { callStructured, type UsageLike } from "./llm.js";
import { maskPersonalData } from "./privacy.js";

/**
 * A member's clock. The zone they chose (in the chat or the Mini App) comes first; then their device's zone, taken
 * once, unless the card has their own word for a place or the chat named one since; then the place on their card
 * when it has a single time zone; otherwise the chat's zone. A place that spans several zones («Канада») settles
 * nothing: the clock stays the chat's and is marked unknown, until what they say tells which.
 */

export const CHOSEN_SOURCES = ["chat", "app", "device"] as const;
/** How a zone stored on a card got there: asked for in the chat, picked in the Mini App, or read from the device. */
export type ChosenSource = (typeof CHOSEN_SOURCES)[number];
export type ClockSource = ChosenSource | "card" | "chat_zone";

export interface MemberClock {
  zone: string;
  source: ClockSource;
  /** The card's place the zone follows (source "card"), or the place that spans several zones (unclear). */
  place: string | null;
  /** How many time zones that place spans, when it spans several and nothing else settles the clock. */
  unclear: number | null;
  /** Those zones, one for each time the place keeps, to pick from. */
  choices: string[];
}

const KNOWN = new Map(Intl.supportedValuesOf("timeZone").map((zone) => [zone.toLowerCase(), zone]));
const NAME_SHAPE = /^(?:UTC|GMT|Etc\/[A-Za-z0-9+-]+|[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+)$/i;
const PROPER_CASE = /^[A-Z][A-Za-z]*(?:\/[A-Z][A-Za-z0-9+-]*(?:_[A-Za-z0-9+-]+)*)+$/;

/**
 * The IANA name of a zone as it is kept, or null: «asia/jakarta» → Asia/Jakarta. Only names: an offset is
 * offsetZone's, and an abbreviation (EST, MSK) is a place for the model to place. An alias Intl knows by an older
 * name (Asia/Kolkata for Asia/Calcutta) is kept as written.
 */
export function zoneName(text: string): string | null {
  const name = text.trim();
  if (!NAME_SHAPE.test(name)) return null;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  return KNOWN.get(name.toLowerCase()) ?? (PROPER_CASE.test(name) ? name : resolved);
}

/** UTC+7, GMT-3 or +03:00 as a zone of its own (the Etc names count the other way round); null for part of an hour. */
export function offsetZone(text: string): string | null {
  const match = /^(?:UTC|GMT)?\s*([+−–-])\s*(\d{1,2})(?::?(\d{2}))?$/i.exec(text.trim());
  if (!match) return null;
  const hours = Number(match[2]);
  if (Number(match[3] ?? 0) !== 0) return null;
  if (hours === 0) return "UTC";
  const east = match[1] === "+";
  if (hours > (east ? 14 : 12)) return null;
  return `Etc/GMT${east ? "-" : "+"}${hours}`;
}

/** A place written as a zone name or an offset, which needs no model; null for a place that does. */
export function writtenZone(text: string): string | null {
  return zoneName(text) ?? offsetZone(text);
}

/** A zone as people read it: Etc/GMT-7 is UTC+7 (the Etc names count the other way round), anything else its name. */
export function zoneLabel(zone: string): string {
  const fixed = /^Etc\/(?:GMT|UTC)(?:([+-])(\d{1,2}))?$/.exec(zone);
  if (!fixed) return zone;
  if (!fixed[1] || fixed[2] === "0") return "UTC";
  return `UTC${fixed[1] === "-" ? "+" : "−"}${fixed[2]}`;
}

/** Minutes east of UTC at a moment. */
export function offsetAt(zone: string, at: Date): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" }).formatToParts(at).find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const match = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
  return match ? (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3] ?? 0)) : 0;
}

const QUARTER_MS = 91 * 86_400_000;

/** Zones that show the same time all year round count once: the first of them stays. */
export function distinctClocks(zones: string[], now = new Date()): string[] {
  const seen = new Map<string, string>();
  for (const zone of zones) {
    const year = [0, 1, 2, 3].map((quarter) => offsetAt(zone, new Date(now.getTime() + quarter * QUARTER_MS))).join("/");
    if (!seen.has(year)) seen.set(year, zone);
  }
  return [...seen.values()];
}

/** «Wed 11 Nov, 06:30». */
export function localStamp(at: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
}

/** «06:30». */
export function localTimeOf(at: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
}

/** «Wed 11 Nov». */
export function localDay(at: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", day: "numeric", month: "short" }).format(at);
}

/** YYYY-MM-DD in a zone. */
export const isoDayIn = (at: Date, zone: string) => at.toLocaleDateString("en-CA", { timeZone: zone });

/** A time of day as the chronicler writes down someone's own clock: «04:00», «16:20». */
export const CLOCK_TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/**
 * The minutes of the day a stated clock may mean. People round: a bare hour («4 утра», written «04:00») is anything
 * from twenty minutes before it to its end, a time with minutes ten minutes either way. Null for anything but a time.
 */
export function clockWindow(time: string): { from: number; to: number } | null {
  const match = CLOCK_TIME.exec(time.trim());
  if (!match) return null;
  const said = Number(match[1]) * 60 + Number(match[2]);
  const [from, to] = Number(match[2]) === 0 ? [said - 20, said + 59] : [said - 10, said + 10];
  const day = 24 * 60;
  return { from: (from + day) % day, to: to % day };
}

/** The zones among `zones` whose clock showed a time in the window at that moment. */
export function zonesShowing(zones: string[], window: { from: number; to: number }, at: Date): string[] {
  const utc = at.getUTCHours() * 60 + at.getUTCMinutes();
  const within = (minute: number) => (window.from <= window.to ? minute >= window.from && minute <= window.to : minute >= window.from || minute <= window.to);
  return zones.filter((zone) => within((((utc + offsetAt(zone, at)) % 1440) + 1440) % 1440));
}

export type ClockOutcome = "narrowed" | "agrees" | "unsettled" | "no_time";

/**
 * What a member said their own clock showed, as the chronicler heard it, worked out in code, never by the model. It
 * only ever tells which zone of a place of theirs that spans several («Канада») is theirs: when exactly one of that
 * place's zones showed that time then, their own row narrows to it, the message joining its sources. A bare hour
 * cannot tell neighbouring zones apart, so most clocks settle nothing, and nothing is ever written from a clock alone.
 */
export async function noteClock(sql: Queryable, input: { chatId: number; userId: number; time: string; at: Date; msgId: number }): Promise<ClockOutcome> {
  const window = clockWindow(input.time);
  if (!window) return "no_time";
  const places = await sql<{ id: number; zones: string[] | null; source_msg_ids: number[] }[]>`
    SELECT id, zones, source_msg_ids FROM facts
    WHERE chat_id = ${input.chatId} AND user_id = ${input.userId} AND kind = 'timezone'
      AND (status = 'manual' OR (status = 'auto' AND confidence >= ${MIN_VISIBLE_CONFIDENCE}))`;
  const placed = places.filter((place) => (place.zones?.length ?? 0) > 0);
  const single = placed.find((place) => place.zones!.length === 1);
  if (single) return zonesShowing(single.zones!, window, input.at).length ? "agrees" : "unsettled";
  const several = placed.find((place) => place.zones!.length > 1);
  if (!several) return "unsettled";
  const fits = distinctClocks(zonesShowing(several.zones!, window, input.at), input.at);
  if (fits.length !== 1) return "unsettled";
  const sources = [...new Set([...several.source_msg_ids, input.msgId])].slice(-10);
  await sql`UPDATE facts SET zones = ${fits}, source_msg_ids = ${sources}, updated_at = now() WHERE id = ${several.id} AND zones = ${several.zones!}`;
  return "narrowed";
}

/** «UTC+1», «UTC−3:30», «UTC». */
export function utcOffset(zone: string, at: Date): string {
  const minutes = offsetAt(zone, at);
  if (minutes === 0) return "UTC";
  const size = Math.abs(minutes);
  return `UTC${minutes > 0 ? "+" : "−"}${Math.floor(size / 60)}${size % 60 ? `:${String(size % 60).padStart(2, "0")}` : ""}`;
}

/** «7 h ahead of», «1 h 30 min behind», or null for the same time. */
export function zoneGap(zone: string, from: string, at: Date): string | null {
  const minutes = offsetAt(zone, at) - offsetAt(from, at);
  if (minutes === 0) return null;
  const size = Math.abs(minutes);
  const amount = `${Math.floor(size / 60) ? `${Math.floor(size / 60)} h` : ""}${size % 60 ? `${Math.floor(size / 60) ? " " : ""}${size % 60} min` : ""}`;
  return `${amount} ${minutes > 0 ? "ahead of" : "behind"}`;
}

export interface PlaceOnCard {
  value: string;
  zones: string[] | null;
  /** When it was last said: the newest of its source messages, or when the member wrote it. */
  at?: Date | string | null;
  /** The member's own word for it (the Mini App, a request in the chat), not the chronicler's. */
  manual?: boolean;
}

/**
 * The clock of a member from what their card holds; the places come strongest first (their own word, then the newest).
 * A zone they chose wins over everything. Their device's zone, taken once, gives way to a place of one zone that is
 * their own word, or that the chat named after it: like the rest of the card, where someone is follows what they say.
 */
export function clockOf(
  member: { time_zone: string | null; time_zone_source: ChosenSource | null; time_zone_set_at?: Date | string | null; opted_out: boolean },
  places: PlaceOnCard[],
  chatZone: string,
): MemberClock {
  const chats: MemberClock = { zone: chatZone, source: "chat_zone", place: null, unclear: null, choices: [] };
  if (member.opted_out) return chats;
  const single = places.find((place) => place.zones?.length === 1);
  const chosen = member.time_zone ? zoneName(member.time_zone) : null;
  const time = (at: Date | string | null | undefined) => (at ? new Date(at).getTime() : 0);
  const placeSince = member.time_zone_source === "device" && single !== undefined && (single.manual === true || time(single.at) > time(member.time_zone_set_at));
  if (chosen && !placeSince) return { ...chats, zone: chosen, source: member.time_zone_source ?? "app" };
  if (single) return { ...chats, zone: single.zones![0]!, source: "card", place: single.value };
  const several = places.find((place) => (place.zones?.length ?? 0) > 1);
  return several ? { ...chats, place: several.value, unclear: several.zones!.length, choices: several.zones! } : chats;
}

interface ClockRow {
  user_id: number;
  time_zone: string | null;
  time_zone_source: ChosenSource | null;
  time_zone_set_at: Date | null;
  opted_out: boolean;
  places: PlaceOnCard[];
}

async function clockRows(sql: Queryable, chatId: number, userIds: number[] | null): Promise<ClockRow[]> {
  return sql<ClockRow[]>`
    SELECT m.user_id, m.time_zone, m.time_zone_source, m.time_zone_set_at, m.opted_out,
           coalesce(json_agg(json_build_object('value', f.value, 'zones', f.zones, 'at', f.said_at, 'manual', f.status = 'manual')
                             ORDER BY f.status = 'manual' DESC, f.said_at DESC, f.confidence DESC, f.id DESC)
                    FILTER (WHERE f.id IS NOT NULL), '[]') AS places
    FROM members m
    -- When a place was said is its newest source message, not when a clean-up last touched the row.
    LEFT JOIN LATERAL (
      SELECT f.*, coalesce((SELECT max(s.sent_at) FROM messages s WHERE s.chat_id = f.chat_id AND s.msg_id = ANY(f.source_msg_ids)), f.updated_at) AS said_at
      FROM facts f
      WHERE f.chat_id = m.chat_id AND f.user_id = m.user_id AND f.kind = 'timezone'
        AND (f.status = 'manual' OR (f.status = 'auto' AND f.confidence >= ${MIN_VISIBLE_CONFIDENCE}))
    ) f ON true
    WHERE m.chat_id = ${chatId} AND (${userIds === null} OR m.user_id = ANY(${userIds ?? []}::int[]))
    GROUP BY m.user_id, m.time_zone, m.time_zone_source, m.time_zone_set_at, m.opted_out`;
}

/** Every member's clock in a chat. */
export async function chatClocks(sql: Queryable, chatId: number, chatZone: string): Promise<Map<number, MemberClock>> {
  return new Map((await clockRows(sql, chatId, null)).map((row) => [row.user_id, clockOf(row, row.places, chatZone)]));
}

/** One member's clock; the chat's for someone who is not a member. */
export async function memberClock(sql: Queryable, chatId: number, userId: number, chatZone: string): Promise<MemberClock> {
  const [row] = await clockRows(sql, chatId, [userId]);
  return row ? clockOf(row, row.places, chatZone) : { zone: chatZone, source: "chat_zone", place: null, unclear: null, choices: [] };
}

export interface ChosenZone {
  zone: string | null;
  source: ChosenSource | null;
  /** When it was set or cleared; null on a card that never had one, which the device's zone may still fill. */
  set_at?: Date | null;
}

/**
 * Sets the zone a member chose, or clears it with null; returns what it was, for an Undo. A zone cleared by hand
 * stays a choice, so the device's zone is not taken onto the card again; an Undo that gives `set_at` puts it back.
 */
export async function setChosenZone(sql: Sql, chatId: number, userId: number, chosen: ChosenZone, actorUserId: number): Promise<ChosenZone | null> {
  return sql.begin(async (tx) => {
    const [before] = await tx<{ zone: string | null; source: ChosenSource | null; set_at: Date | null }[]>`
      SELECT time_zone AS zone, time_zone_source AS source, time_zone_set_at AS set_at FROM members WHERE chat_id = ${chatId} AND user_id = ${userId} FOR UPDATE`;
    if (!before) return null;
    const source = chosen.zone === null ? null : (chosen.source ?? "app");
    const setAt = chosen.set_at === undefined ? new Date() : chosen.set_at;
    await tx`
      UPDATE members SET time_zone = ${chosen.zone}, time_zone_source = ${source}, time_zone_set_at = ${setAt}
      WHERE chat_id = ${chatId} AND user_id = ${userId}`;
    await tx`
      INSERT INTO change_log (entity, entity_id, op, before, after, source, actor_user_id)
      VALUES ('user', ${userId}, 'set_time_zone', ${tx.json({ zone: before.zone, source: before.source })}, ${tx.json({ zone: chosen.zone, source, chat_id: chatId })}, 'user', ${actorUserId})`;
    return before;
  }) as Promise<ChosenZone | null>;
}

/**
 * The device's zone, taken once, onto a card that never had one: the device never changes it again, and a place they
 * name in the chat afterwards, or a zone they choose, takes over (see clockOf). Whether it was taken.
 */
export async function seedDeviceZone(sql: Sql, chatId: number, userId: number, zone: string): Promise<boolean> {
  const updated = await sql`
    UPDATE members SET time_zone = ${zone}, time_zone_source = 'device', time_zone_set_at = now()
    WHERE chat_id = ${chatId} AND user_id = ${userId} AND NOT opted_out AND time_zone IS NULL AND time_zone_set_at IS NULL`;
  if (updated.count === 0) return false;
  await sql`
    INSERT INTO change_log (entity, entity_id, op, after, source, actor_user_id)
    VALUES ('user', ${userId}, 'set_time_zone', ${sql.json({ zone, source: "device", chat_id: chatId })}, 'user', ${userId})`;
  return true;
}

export const PLACE_ZONES_PURPOSE = "place_zones";
export const PLACE_ZONES_TIMEOUT_MS = 15_000;

export const PLACE_ZONES_SYSTEM_PROMPT = `You place places in time zones. For each place someone wrote on their profile, give the IANA names of the time zones people there live by:
- a city, a town or an island: its one zone (Торонто → America/Toronto, Тбилиси → Asia/Tbilisi, Бали → Asia/Makassar);
- a country or a region on one official time: that one zone (Китай → Asia/Shanghai, Польша → Europe/Warsaw, Индия → Asia/Kolkata);
- a country or a region on several: one zone for each time it keeps, the zone of its main city (Канада → America/St_Johns, America/Halifax, America/Toronto, America/Winnipeg, America/Edmonton, America/Vancouver; Индонезия → Asia/Jakarta, Asia/Makassar, Asia/Jayapura);
- a time zone named some other way («по Москве», «MSK», «Pacific time», «CET»): its zone;
- anything that is no place on Earth and no time zone (a joke, a planet, «дома», «везде», «в пути»): no zones.
Words around a place change nothing: «Лиссабон (пока)» is Lisbon, «Порту, Португалия» is Porto. Only real IANA names, never an abbreviation or an offset. Answer every place once, under its number as given (q1, q2…).`;

const PlaceZonesSchema = z.strictObject({
  places: z.array(z.strictObject({ ref: z.string(), zones: z.array(z.string()) })),
});

export interface PlaceZonesRequest {
  anthropic: Anthropic;
  model: string;
  onUsage: (usage: UsageLike) => Promise<void>;
  signal?: AbortSignal;
  endUserId?: string;
}

/**
 * The time zones of each place, keyed by the place as given: only real zone names, and zones that keep the same time
 * all year count once; none for a place the model could not place. Null when the model could not be asked.
 */
export async function placeZones(places: string[], request: PlaceZonesRequest): Promise<Map<string, string[]> | null> {
  const wanted = [...new Set(places.map((place) => place.trim()).filter(Boolean))];
  const zones = new Map<string, string[]>();
  const asked = wanted.filter((place) => {
    const written = writtenZone(place);
    if (written) zones.set(place, [written]);
    return !written;
  });
  if (asked.length === 0) return zones;
  // One line a place: words in a place cannot open a line of their own and pass for another place.
  const line = (place: string) => maskPersonalData(place).replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  const outcome = await callStructured(request.anthropic, {
    model: request.model,
    maxTokens: 1500,
    effort: "low",
    system: PLACE_ZONES_SYSTEM_PROMPT,
    prompt: `<places>\n${asked.map((place, index) => `q${index + 1}: ${line(place)}`).join("\n")}\n</places>`,
    schema: PlaceZonesSchema,
    onUsage: request.onUsage,
    signal: request.signal,
    endUserId: request.endUserId,
  }).catch((error: unknown) => ({ ok: false as const, message: error instanceof Error ? error.message : String(error) }));
  if (!outcome.ok) {
    console.log(`[zones] could not place ${asked.length} place(s): ${outcome.message}`);
    return null;
  }
  // A place answered twice, left out, or only with names that are no zones stays unplaced, to be asked again.
  const refOf = (item: { ref: string }) => item.ref.trim().toLowerCase();
  const answers = new Map<string, number>();
  for (const item of outcome.data.places) answers.set(refOf(item), (answers.get(refOf(item)) ?? 0) + 1);
  for (const item of outcome.data.places) {
    const place = asked[Number(/^q(\d+)$/.exec(refOf(item))?.[1] ?? 0) - 1];
    if (place === undefined || answers.get(refOf(item))! > 1) continue;
    const named = [...new Set(item.zones.map(zoneName).filter((zone): zone is string => zone !== null))];
    if (item.zones.length > 0 && named.length === 0) continue;
    zones.set(place, distinctClocks(named));
  }
  const unplaced = asked.filter((place) => !zones.has(place));
  if (unplaced.length) console.log(`[zones] the model gave no usable zones for ${unplaced.length} of ${asked.length} place(s)`);
  return zones;
}

export interface Placing {
  /** Places now in one zone or several. */
  placed: number;
  /** Words that name no place: kept with no zones, never asked about again. */
  nowhere: number;
  /** Places the model could not be asked about or gave nothing usable for: asked again later. */
  unplaced: number;
}

/**
 * Works out the time zones of the places on the cards of a chat that have none yet. Each member's places go to the
 * model on their own, so nothing one member writes on their card can place anyone else's.
 */
export async function placeCardPlaces(sql: Sql, chatId: number, resolve: (places: string[]) => Promise<Map<string, string[]> | null>, limit = 20): Promise<Placing> {
  const facts = await sql<{ id: number; user_id: number; value: string }[]>`
    SELECT id, user_id, value FROM facts
    WHERE chat_id = ${chatId} AND kind = 'timezone' AND zones IS NULL AND (status = 'manual' OR (status = 'auto' AND confidence >= ${MIN_VISIBLE_CONFIDENCE}))
    ORDER BY id LIMIT ${limit}`;
  const placing: Placing = { placed: 0, nowhere: 0, unplaced: 0 };
  const members = [...new Set(facts.map((fact) => fact.user_id))];
  for (const member of members) {
    const own = facts.filter((fact) => fact.user_id === member);
    const zones = await resolve(own.map((fact) => fact.value));
    for (const fact of own) {
      const found = zones?.get(fact.value.trim());
      if (!found) {
        placing.unplaced += 1;
        continue;
      }
      // The value is checked again: one reworded meanwhile is placed on the next round.
      const updated = (await sql`UPDATE facts SET zones = ${found} WHERE id = ${fact.id} AND value = ${fact.value} AND zones IS NULL`).count;
      if (updated) placing[found.length ? "placed" : "nowhere"] += 1;
    }
  }
  return placing;
}
