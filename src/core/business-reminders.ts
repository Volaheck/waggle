import type { Sql } from "./db.js";

export type ReminderKind = "promise" | "plan";
export type CommittedBy = "me" | "them" | "both";
export type ReminderStatus = "open" | "sent" | "done" | "dropped";

export interface DialogueLine {
  connectionId: string;
  chatId: number;
  msgId: number;
  fromOwner: boolean;
  chatName: string;
  text: string;
  sentAt: Date;
}

export interface Reminder {
  id: number;
  connection_id: string;
  chat_id: number;
  chat_name: string;
  kind: ReminderKind;
  committed_by: CommittedBy;
  what: string;
  due_at: Date | null;
  due_has_time: boolean;
  remind_at: Date;
  status: ReminderStatus;
  source_msg_id: number | null;
}

/** Lines the model has not read yet are dropped after this long too: a backlog never grows without bound. */
export const DIALOGUE_KEEP_DAYS = 2;
const CLOSED_REMINDERS_KEEP_DAYS = 30;

export async function saveDialogueLine(sql: Sql, line: DialogueLine): Promise<void> {
  await sql`
    INSERT INTO business_dialogue (connection_id, chat_id, msg_id, from_owner, chat_name, text, sent_at)
    VALUES (${line.connectionId}, ${line.chatId}, ${line.msgId}, ${line.fromOwner}, ${line.chatName}, ${line.text}, ${line.sentAt})
    ON CONFLICT (connection_id, chat_id, msg_id) DO UPDATE SET text = excluded.text, chat_name = excluded.chat_name
    WHERE NOT business_dialogue.processed`;
}

export interface PendingChat {
  connection_id: string;
  chat_id: number;
  owner_tg_id: number;
  owner_chat_id: number;
}

/** Chats whose unread lines are due for a look: the conversation has been quiet for `idleMinutes`, or the oldest line waited `maxWaitMinutes`. */
export async function chatsToRead(sql: Sql, idleMinutes: number, maxWaitMinutes: number): Promise<PendingChat[]> {
  return sql<PendingChat[]>`
    SELECT d.connection_id, d.chat_id, c.owner_tg_id, c.owner_chat_id
    FROM business_dialogue d JOIN business_connections c ON c.id = d.connection_id AND c.enabled
    WHERE NOT d.processed
    GROUP BY d.connection_id, d.chat_id, c.owner_tg_id, c.owner_chat_id
    HAVING max(d.sent_at) < now() - make_interval(mins => ${idleMinutes}) OR min(d.sent_at) < now() - make_interval(mins => ${maxWaitMinutes})
    ORDER BY min(d.sent_at)`;
}

interface DialogueRow {
  msg_id: number;
  from_owner: boolean;
  chat_name: string;
  text: string;
  sent_at: Date;
}

export async function dialogueFor(sql: Sql, connectionId: string, chatId: number, limits: { pending: number; context: number }) {
  const pending = await sql<DialogueRow[]>`
    SELECT msg_id, from_owner, chat_name, text, sent_at FROM business_dialogue
    WHERE connection_id = ${connectionId} AND chat_id = ${chatId} AND NOT processed
    ORDER BY sent_at, msg_id LIMIT ${limits.pending}`;
  const first = pending[0];
  const context = first
    ? (
        await sql<DialogueRow[]>`
          SELECT msg_id, from_owner, chat_name, text, sent_at FROM business_dialogue
          WHERE connection_id = ${connectionId} AND chat_id = ${chatId} AND processed AND sent_at <= ${first.sent_at}
          ORDER BY sent_at DESC, msg_id DESC LIMIT ${limits.context}`
      ).reverse()
    : [];
  return { pending, context };
}

export async function markRead(sql: Sql, connectionId: string, chatId: number, msgIds: number[]): Promise<void> {
  await sql`UPDATE business_dialogue SET processed = true WHERE connection_id = ${connectionId} AND chat_id = ${chatId} AND msg_id = ANY(${msgIds}::bigint[])`;
}

export async function activeReminders(sql: Sql, connectionId: string, chatId?: number): Promise<Reminder[]> {
  const scope = chatId ?? null;
  return sql<Reminder[]>`
    SELECT * FROM business_reminders
    WHERE connection_id = ${connectionId} AND status IN ('open', 'sent') AND (${scope}::bigint IS NULL OR chat_id = ${scope}::bigint)
    ORDER BY coalesce(due_at, remind_at), id`;
}

export async function addReminder(
  sql: Sql,
  reminder: Omit<Reminder, "id" | "status">,
): Promise<Reminder> {
  const [row] = await sql<Reminder[]>`
    INSERT INTO business_reminders (connection_id, chat_id, chat_name, kind, committed_by, what, due_at, due_has_time, remind_at, source_msg_id)
    VALUES (${reminder.connection_id}, ${reminder.chat_id}, ${reminder.chat_name}, ${reminder.kind}, ${reminder.committed_by}, ${reminder.what},
            ${reminder.due_at}, ${reminder.due_has_time}, ${reminder.remind_at}, ${reminder.source_msg_id})
    RETURNING *`;
  return row!;
}

/** Closes active reminders of one chat; ids from elsewhere are ignored. */
export async function closeReminders(sql: Sql, connectionId: string, chatId: number, ids: number[], status: "done" | "dropped"): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await sql`
    UPDATE business_reminders SET status = ${status}
    WHERE id = ANY(${ids}::bigint[]) AND connection_id = ${connectionId} AND chat_id = ${chatId} AND status IN ('open', 'sent')
    RETURNING 1`;
  return rows.length;
}

/** The reminder with the owner who may act on it, when that owner's connection is still on. */
export async function reminderForOwner(sql: Sql, id: number, ownerTgId: number): Promise<Reminder | undefined> {
  const [row] = await sql<Reminder[]>`
    SELECT r.* FROM business_reminders r JOIN business_connections c ON c.id = r.connection_id
    WHERE r.id = ${id} AND c.owner_tg_id = ${ownerTgId} AND c.enabled`;
  return row;
}

export async function setReminderStatus(sql: Sql, id: number, status: ReminderStatus, remindAt?: Date): Promise<void> {
  await sql`UPDATE business_reminders SET status = ${status}, remind_at = coalesce(${remindAt ?? null}::timestamptz, remind_at) WHERE id = ${id}`;
}

export interface DueReminder extends Reminder {
  owner_tg_id: number;
  owner_chat_id: number;
}

export async function dueReminders(sql: Sql): Promise<DueReminder[]> {
  return sql<DueReminder[]>`
    SELECT r.*, c.owner_tg_id, c.owner_chat_id FROM business_reminders r JOIN business_connections c ON c.id = r.connection_id AND c.enabled
    WHERE r.status = 'open' AND r.remind_at <= now()
    ORDER BY r.remind_at LIMIT 50`;
}

export async function clearOldDialogue(sql: Sql): Promise<number> {
  const lines = await sql`DELETE FROM business_dialogue WHERE sent_at < now() - make_interval(days => ${DIALOGUE_KEEP_DAYS}) RETURNING 1`;
  await sql`
    DELETE FROM business_reminders
    WHERE status <> 'open' AND coalesce(due_at, remind_at) < now() - make_interval(days => ${CLOSED_REMINDERS_KEEP_DAYS})`;
  return lines.length;
}

export async function spentOnRemindersUsd(sql: Sql, purpose: string): Promise<number> {
  const [row] = await sql<{ total: string | null }[]>`
    SELECT sum(cost_usd)::text AS total FROM llm_usage WHERE at >= date_trunc('month', now()) AND purpose = ${purpose}`;
  return Number(row?.total ?? 0);
}

// ---------- Local time ----------

const pad = (value: number) => String(value).padStart(2, "0");

/** The wall-clock parts of an instant in a time zone. */
function wallClock(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)!.value;
  return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")), hour: Number(get("hour")), minute: Number(get("minute")), second: Number(get("second")), weekday: get("weekday") };
}

export function localDate(at: Date, timeZone: string): string {
  const clock = wallClock(at, timeZone);
  return `${clock.year}-${pad(clock.month)}-${pad(clock.day)}`;
}

export function localTime(at: Date, timeZone: string): string {
  const clock = wallClock(at, timeZone);
  return `${pad(clock.hour)}:${pad(clock.minute)}`;
}

export function weekdayOf(at: Date, timeZone: string): string {
  return wallClock(at, timeZone).weekday;
}

/** The instant a local date and time ("2026-11-10", "19:00") stand for in a time zone. */
export function zonedTime(date: string, time: string, timeZone: string): Date {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const [hour, minute] = time.split(":").map(Number) as [number, number];
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute);
  const offsetAt = (instant: number) => {
    const clock = wallClock(new Date(instant), timeZone);
    return Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second) - instant;
  };
  const first = asIfUtc - offsetAt(asIfUtc);
  return new Date(asIfUtc - offsetAt(first));
}

export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

export interface Commitment {
  kind: ReminderKind;
  by: CommittedBy;
  /** Local date, or null when none can be told (a promise only). */
  date: string | null;
  /** Local HH:MM, or null. */
  time: string | null;
}

/**
 * When to remind about a commitment, and when it is due; null when every sensible moment has passed. A plan comes
 * two hours ahead, the owner's own promise an hour ahead (that morning without a time), the other side's promise
 * when it is due ("did they?"). A promise without a date comes the next morning.
 */
export function scheduleFor(item: Commitment, now: Date, timeZone: string): { dueAt: Date | null; dueHasTime: boolean; remindAt: Date } | null {
  const at = (date: string, time: string) => zonedTime(date, time, timeZone);
  const today = localDate(now, timeZone);
  if (!item.date) {
    if (item.kind === "plan") return null;
    return { dueAt: null, dueHasTime: false, remindAt: at(addDays(today, 1), "10:00") };
  }
  const due = item.time ? at(item.date, item.time) : null;
  let candidates: Date[];
  if (due) {
    if (item.kind === "plan") candidates = [new Date(due.getTime() - 2 * HOUR), new Date(due.getTime() - 30 * MINUTE)];
    else if (item.by === "them") candidates = [due, new Date(due.getTime() + HOUR)];
    else candidates = [new Date(due.getTime() - HOUR), new Date(due.getTime() - 15 * MINUTE)];
  } else if (item.kind === "plan") {
    candidates = [at(item.date, "09:00")];
  } else if (item.by === "them") {
    candidates = [at(item.date, "18:00"), at(item.date, "21:00")];
  } else {
    candidates = [at(item.date, "10:00"), at(item.date, "18:00")];
  }
  const remindAt = candidates.find((candidate) => candidate.getTime() > now.getTime() + MINUTE);
  if (!remindAt) return null;
  return { dueAt: due ?? at(item.date, "23:59"), dueHasTime: Boolean(due), remindAt };
}
