/**
 * When a reminder a member asks for is due, worked out in code and never by a model: the reading only says what was
 * asked (a span, a date, a time of day, an offset before a moment), and this turns it into an instant on the member's
 * own clock. Spans of minutes and hours are exact; days, weeks, months and years count on the member's local calendar
 * and keep the time of day, so «через 2 месяца» stays at the same o'clock across a change to summer time, and a month
 * after 31 January is the last day of February. A local time the clocks skip comes as much later as they jump; one
 * they pass twice is the first of the two.
 */

export const REMINDER_UNITS = ["minutes", "hours", "days", "weeks", "months", "years"] as const;
export type ReminderUnit = (typeof REMINDER_UNITS)[number];
type CalendarUnit = Exclude<ReminderUnit, "minutes" | "hours">;

/** One part of a span: «через месяц и неделю» has two. */
export interface ReminderSpan {
  amount: number;
  unit: ReminderUnit;
}

/** What a request says about when, as the reading gives it. */
export interface ReminderWhen {
  /** The words that say when, as written: whether they name an hour at all. */
  words?: string | null;
  /** A span from the moment those words were written, in parts. */
  in: ReminderSpan[] | null;
  /** A local date, YYYY-MM-DD. */
  date: string | null;
  /** A local time of day, HH:MM. */
  time: string | null;
  /** How long before the moment the rest gives («за 2 дня до 1 марта»), in parts. */
  before?: ReminderSpan[] | null;
}

/** A date asked for without a time of day is due at this local time. */
export const DEFAULT_TIME = "10:00";
/** A reminder is due at least this far ahead… */
export const MIN_LEAD_MS = 60_000;
/** …and at most this many years ahead on the member's calendar. */
export const MAX_YEARS_AHEAD = 5;
/** How many of the member's next days the reading is shown, to pick «в пятницу» from. */
export const CALENDAR_DAYS = 21;
/** How far back the calendar reaches for a message written on an earlier day, whose «завтра» counts from that day. */
export const CALENDAR_DAYS_BACK = 14;
/** A span or an offset has at most this many parts. */
const MAX_PARTS = 6;

/**
 * - no_time: nothing says when; bad_time: what it says cannot be read; which_hour: a day, or a part of one, that is
 *   under way, without an hour still ahead in it («сегодня» at 15:00, «вечером» at 20:00).
 * - past, too_soon, too_far: a time that is no longer ahead, under a minute ahead, or over five years on.
 */
export type DueProblem = "no_time" | "bad_time" | "which_hour" | "past" | "too_soon" | "too_far";
export type Due = { ok: true; at: Date } | { ok: false; problem: DueProblem };

export interface LocalDate {
  year: number;
  month: number;
  day: number;
}

export interface LocalTime {
  hour: number;
  minute: number;
  second?: number;
  millisecond?: number;
}

export interface WallClock extends LocalDate {
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  weekday: string;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const EXACT_MS: Partial<Record<ReminderUnit, number>> = { minutes: MINUTE_MS, hours: HOUR_MS };
/** Roughly how many days a span covers, so an absurd one is turned down before any date arithmetic. */
const SPAN_DAYS: Record<ReminderUnit, number> = { minutes: 1 / 1440, hours: 1 / 24, days: 1, weeks: 7, months: 31, years: 366 };
const MAX_SPAN_DAYS = MAX_YEARS_AHEAD * 366 + 31;

/**
 * The hours the reading gives a part of the day named without one («утром» 09:00, «днём» 13:00, «вечером» 19:00,
 * «ночью» 23:00), and the local hours that part lasts.
 */
const PARTS_OF_DAY = [
  { hour: 9, from: 5, to: 12 },
  { hour: 13, from: 12, to: 17 },
  { hour: 19, from: 17, to: 23 },
  { hour: 23, from: 23, to: 24 },
] as const;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

const pad = (value: number, size = 2) => String(value).padStart(size, "0");

/** «2027-01-12». */
export const isoDate = (date: LocalDate) => `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)}`;

/** «14:05». */
export const clockTime = (time: { hour: number; minute: number }) => `${pad(time.hour)}:${pad(time.minute)}`;

function weekdayOf(date: LocalDate): string {
  return WEEKDAYS[new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()]!;
}

function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const dayNumber = (date: LocalDate) => Date.UTC(date.year, date.month - 1, date.day) / DAY_MS;
const sameDay = (one: LocalDate, other: LocalDate) => dayNumber(one) === dayNumber(other);

/** The local date and time of an instant in a zone. */
export function wallClock(at: Date, zone: string): WallClock {
  const parts = formatterFor(zone).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)!.value);
  const date = { year: part("year"), month: part("month"), day: part("day") };
  return { ...date, hour: part("hour"), minute: part("minute"), second: part("second"), millisecond: at.getUTCMilliseconds(), weekday: weekdayOf(date) };
}

/** «2026-11-12 Thu 14:27» in a zone. */
export function localStamp(at: Date, zone: string): string {
  const clock = wallClock(at, zone);
  return `${isoDate(clock)} ${clock.weekday} ${clockTime(clock)}`;
}

/** A YYYY-MM-DD date that exists, or null. */
export function parseDate(text: string): LocalDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  return date.month >= 1 && date.month <= 12 && date.day >= 1 && date.day <= daysIn(date.year, date.month) ? date : null;
}

/** A 24-hour HH:MM time of day, or null. */
export function parseTime(text: string): { hour: number; minute: number } | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text.trim());
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null;
}

/** A date moved on the calendar; months and years keep the day of the month where the month has it, else take its last. */
export function addToDate(date: LocalDate, amount: number, unit: CalendarUnit): LocalDate {
  if (unit === "days" || unit === "weeks") {
    const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + amount * (unit === "weeks" ? 7 : 1)));
    return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
  }
  const months = date.month - 1 + amount * (unit === "years" ? 12 : 1);
  const year = date.year + Math.floor(months / 12);
  const month = (((months % 12) + 12) % 12) + 1;
  return { year, month, day: Math.min(date.day, daysIn(year, month)) };
}

/**
 * The instant a local date and time stand for in a zone. A time the clocks skip (from 02:00 straight to 03:00) is as
 * much later as they jump, 02:30 becoming 03:30; a time they pass twice (back from 03:00 to 02:00) is the first of the two.
 */
export function localInstant(date: LocalDate, time: LocalTime, zone: string): Date {
  const asIfUtc = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute, time.second ?? 0, time.millisecond ?? 0);
  const offsetAt = (instant: number) => {
    const clock = wallClock(new Date(instant), zone);
    return Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second, clock.millisecond) - instant;
  };
  const before = offsetAt(asIfUtc - DAY_MS);
  const offsets = new Set([before, offsetAt(asIfUtc), offsetAt(asIfUtc + DAY_MS)]);
  const fitting = [...offsets]
    .map((offset) => asIfUtc - offset)
    .filter((instant) => offsetAt(instant) === asIfUtc - instant)
    .sort((a, b) => a - b);
  // A skipped time read with the offset from before the jump lands that much past it.
  return new Date(fitting[0] ?? asIfUtc - before);
}

/**
 * The member's days around now, each with its weekday: today and tomorrow marked, and, when `since` was an earlier
 * day at most CALENDAR_DAYS_BACK ago, the days from then on marked as past.
 */
export function calendarDays(now: Date, zone: string, since?: Date): string[] {
  const today = wallClock(now, zone);
  const back = since ? dayNumber(today) - dayNumber(wallClock(since, zone)) : 0;
  const reach = back > 0 && back <= CALENDAR_DAYS_BACK ? back : 0;
  return Array.from({ length: reach + CALENDAR_DAYS }, (_, index) => {
    const offset = index - reach;
    const date = addToDate(today, offset, "days");
    const mark = offset < 0 ? " (past)" : offset === 0 ? " (today)" : offset === 1 ? " (tomorrow)" : "";
    return `${isoDate(date)} ${weekdayOf(date)}${mark}`;
  });
}

const validPart = (part: ReminderSpan) => Number.isFinite(part.amount) && part.amount > 0 && (EXACT_MS[part.unit] !== undefined || Number.isInteger(part.amount));

/** A span's parts summed the way people mean them: months (years in them), then days (weeks in them), then exact time. */
function spanTotals(parts: ReminderSpan[]): { months: number; days: number; ms: number } {
  const sum = (units: ReminderUnit[], scale: (unit: ReminderUnit) => number) =>
    parts.filter((part) => units.includes(part.unit)).reduce((total, part) => total + part.amount * scale(part.unit), 0);
  return {
    months: sum(["years", "months"], (unit) => (unit === "years" ? 12 : 1)),
    days: sum(["weeks", "days"], (unit) => (unit === "weeks" ? 7 : 1)),
    ms: Math.round(sum(["hours", "minutes"], (unit) => EXACT_MS[unit]!)),
  };
}

/** An instant moved by a span, its calendar part on the member's calendar at the same local time, its exact part after. */
function moved(at: Date, parts: ReminderSpan[], sign: 1 | -1, zone: string): Date {
  const { months, days, ms } = spanTotals(parts);
  const clock = wallClock(at, zone);
  const onCalendar = months || days ? localInstant(addToDate(addToDate(clock, sign * months, "months"), sign * days, "days"), clock, zone) : at;
  return new Date(onCalendar.getTime() + sign * ms);
}

/** The part of the day a time stands for when the words that gave it name no hour («вечером» is 19:00), or null. */
function partOfDay(time: { hour: number; minute: number }, words: string | null | undefined): (typeof PARTS_OF_DAY)[number] | null {
  if (!words || /\d/.test(words) || time.minute !== 0) return null;
  return PARTS_OF_DAY.find((part) => part.hour === time.hour) ?? null;
}

/**
 * When a reminder is due, from what the reading says, on the member's clock (`zone`), counted from `from` (when the
 * words that say when were written) and checked against `now` (when the request was made):
 * - a span alone: `from` plus the span (minutes and hours exactly, longer spans on the calendar at the same local time);
 * - a span with a time: the local date the span leads to, at that time;
 * - a date: at its time, else at DEFAULT_TIME;
 * - a time alone: that day at that time while it is ahead, else the next day;
 * - an offset before: that much before what the rest gives.
 * A day under way without an hour still ahead in it (a date of today past DEFAULT_TIME, a part of the day named
 * without an hour after its hour, while it lasts) is not guessed: which_hour. It must come at least MIN_LEAD_MS after
 * `now` and at most MAX_YEARS_AHEAD years on.
 */
export function dueAt(when: ReminderWhen, now: Date, zone: string, from: Date = now): Due {
  const date = when.date === null ? null : parseDate(when.date);
  const time = when.time === null ? null : parseTime(when.time);
  const span = when.in ?? [];
  const before = when.before ?? [];
  if ((when.date !== null && !date) || (when.time !== null && !time)) return { ok: false, problem: "bad_time" };
  if ((span.length && date) || span.length > MAX_PARTS || before.length > MAX_PARTS || ![...span, ...before].every(validPart)) return { ok: false, problem: "bad_time" };
  const days = (parts: ReminderSpan[]) => parts.reduce((total, part) => total + part.amount * SPAN_DAYS[part.unit], 0);
  if (days(span) > MAX_SPAN_DAYS) return { ok: false, problem: "too_far" };
  if (days(before) > MAX_SPAN_DAYS) return { ok: false, problem: "bad_time" };
  if (!span.length && !date && !time) return { ok: false, problem: "no_time" };
  const start = wallClock(from, zone);
  const today = wallClock(now, zone);
  const part = time ? partOfDay(time, when.words) : null;
  const underWay = (day: LocalDate) => sameDay(day, today) && (time === null || (part !== null && today.hour >= part.from && today.hour < part.to));
  let at: Date;
  if (span.length) {
    const ahead = moved(from, span, 1, zone);
    at = time ? localInstant(wallClock(ahead, zone), time, zone) : ahead;
  } else if (date) {
    at = localInstant(date, time ?? parseTime(DEFAULT_TIME)!, zone);
    if (!before.length && at.getTime() <= now.getTime() && underWay(date)) return { ok: false, problem: "which_hour" };
  } else {
    const thatDay = localInstant(start, time!, zone);
    if (thatDay.getTime() > from.getTime()) at = thatDay;
    else if (!before.length && part && underWay(start)) return { ok: false, problem: "which_hour" };
    else at = localInstant(addToDate(start, 1, "days"), time!, zone);
  }
  if (before.length) at = moved(at, before, -1, zone);
  return checked(at, now, today, zone);
}

function checked(at: Date, now: Date, today: WallClock, zone: string): Due {
  if (!Number.isFinite(at.getTime())) return { ok: false, problem: "too_far" };
  const ahead = at.getTime() - now.getTime();
  if (ahead <= 0) return { ok: false, problem: "past" };
  if (ahead < MIN_LEAD_MS) return { ok: false, problem: "too_soon" };
  if (at.getTime() > localInstant(addToDate(today, MAX_YEARS_AHEAD, "years"), today, zone).getTime()) return { ok: false, problem: "too_far" };
  return { ok: true, at };
}
