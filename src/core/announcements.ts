import type { Capability } from "./capabilities.js";

/**
 * What counts as news for a chat (src/worker/announcements.ts posts it): a capability of src/core/capabilities.ts it
 * has not been told of, which shipped from the day these notes began and after the bot joined the chat. What shipped
 * before was there all along for the chat, and a chat the bot joins later hears only of what comes after.
 */

/** The day the notes began: nothing that shipped before it is news anywhere. */
export const NOTES_FROM = "2026-11-23";
/** More waits for the next day's note. */
export const MAX_NEWS_PER_NOTE = 5;
/** The notes themselves are no news: the first note in a chat says in passing that they will come. */
export const NOTES_KEY = "announcements";

/** The day of a moment in a time zone, as YYYY-MM-DD. */
export function dayIn(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(at);
}

/** The capabilities a chat joined at `joinedAt` has not been told of, oldest first, at most MAX_NEWS_PER_NOTE of them. */
export function newsFor(capabilities: Record<string, Capability>, joinedAt: Date, told: ReadonlySet<string>, timeZone: string): [string, Capability][] {
  const joined = dayIn(joinedAt, timeZone);
  return Object.entries(capabilities)
    .filter(([key, capability]) => key !== NOTES_KEY && !told.has(key) && capability.shipped >= NOTES_FROM && capability.shipped > joined)
    .sort(([, a], [, b]) => a.shipped.localeCompare(b.shipped))
    .slice(0, MAX_NEWS_PER_NOTE);
}
