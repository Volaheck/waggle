import type { Sql } from "./db.js";
import { asSubject, type Subject } from "./own-card.js";

/**
 * Reminders members ask the bot for in a chat (migrations/013_reminders.sql). Whatever a request does with them runs
 * under the self-edit role, which row-level security confines to the asker's own reminders in the asker's own chat
 * (asSubject): nobody adds, sees or cancels anyone else's, whatever a model or a message says. The delivery worker
 * (src/worker/member-reminders.ts) claims and finishes them under the app's own role.
 */

/** Reminders a member may have waiting in one chat. */
export const MAX_PENDING_REMINDERS = 20;
export const MAX_REMINDER_CHARS = 500;

export type ReminderStatus = "pending" | "sending" | "sent" | "cancelled" | "failed";
export type ReminderLanguage = "Russian" | "English";

export interface MemberReminder {
  id: number;
  chat_id: number;
  user_id: number;
  text: string;
  due_at: Date;
  time_zone: string;
  language: ReminderLanguage;
  source_msg_id: number;
  thread_id: number | null;
  receipt_msg_id: number | null;
  status: ReminderStatus;
  attempts: number;
  claimed_at: Date | null;
  chat_msg_id: number | null;
  dm_msg_id: number | null;
  dm_error: string | null;
  created_at: Date;
  sent_at: Date | null;
  cancelled_at: Date | null;
}

export interface NewReminder {
  text: string;
  dueAt: Date;
  timeZone: string;
  language: ReminderLanguage;
  sourceMsgId: number;
  threadId: number | null;
}

export type AddedReminder = { status: "added"; reminder: MemberReminder } | { status: "opted_out" } | { status: "too_many" } | { status: "handled_already" };

/** The subject's pending reminders in their chat, soonest first. */
export async function ownPendingReminders(sql: Sql, subject: Subject): Promise<MemberReminder[]> {
  return asSubject(sql, subject, (tx) => tx<MemberReminder[]>`
    SELECT * FROM reminders WHERE chat_id = ${subject.chatId} AND user_id = ${subject.userId} AND status = 'pending' ORDER BY due_at, id`);
}

/**
 * Adds a reminder of the subject's own, in one transaction: one message sets one reminder at most, someone who opted
 * out gets none, and nobody keeps more than MAX_PENDING_REMINDERS in a chat. The request that asked for it is settled
 * with it, unless `settle` is false: the same message also asks for a change to their card, which settles it later.
 */
export async function addOwnReminder(sql: Sql, subject: Subject, reminder: NewReminder, requestId: number, settle = true): Promise<AddedReminder> {
  return asSubject(sql, subject, async (tx): Promise<AddedReminder> => {
    const [member] = await tx<{ opted_out: boolean }[]>`SELECT opted_out FROM members WHERE chat_id = ${subject.chatId} AND user_id = ${subject.userId} FOR UPDATE`;
    if (member?.opted_out !== false) return { status: "opted_out" };
    const [pending] = await tx<{ count: number }[]>`
      SELECT count(*)::int AS count FROM reminders WHERE chat_id = ${subject.chatId} AND user_id = ${subject.userId} AND status = 'pending'`;
    if ((pending?.count ?? 0) >= MAX_PENDING_REMINDERS) return { status: "too_many" };
    const [request] = await tx`SELECT 1 FROM self_edits WHERE id = ${requestId} AND status = 'parsing' FOR UPDATE`;
    const [set] = await tx`SELECT 1 FROM reminders WHERE chat_id = ${subject.chatId} AND user_id = ${subject.userId} AND source_msg_id = ${reminder.sourceMsgId}`;
    if (!request || set) return { status: "handled_already" };
    if (settle) await tx`UPDATE self_edits SET kind = 'reminder', status = 'applied', decided_at = now() WHERE id = ${requestId}`;
    const [row] = await tx<MemberReminder[]>`
      INSERT INTO reminders (chat_id, user_id, text, due_at, time_zone, language, source_msg_id, thread_id)
      VALUES (${subject.chatId}, ${subject.userId}, ${reminder.text}, ${reminder.dueAt}, ${reminder.timeZone}, ${reminder.language}, ${reminder.sourceMsgId}, ${reminder.threadId})
      RETURNING *`;
    return { status: "added", reminder: row! };
  });
}

/** The subject's own reminder in their chat whose receipt is this message, whatever became of it; null when it is none of theirs. */
export async function ownReminderByReceipt(sql: Sql, subject: Subject, receiptMsgId: number): Promise<MemberReminder | null> {
  const [row] = await asSubject(sql, subject, (tx) => tx<MemberReminder[]>`
    SELECT * FROM reminders WHERE chat_id = ${subject.chatId} AND user_id = ${subject.userId} AND receipt_msg_id = ${receiptMsgId} ORDER BY id DESC LIMIT 1`);
  return row ?? null;
}

/** A member's reminders still to come in a chat, soonest first: what the bot shows them it keeps about them. */
export async function waitingReminders(sql: Sql, chatId: number, userId: number): Promise<Pick<MemberReminder, "id" | "due_at" | "text">[]> {
  return sql<Pick<MemberReminder, "id" | "due_at" | "text">[]>`
    SELECT id, due_at, text FROM reminders WHERE chat_id = ${chatId} AND user_id = ${userId} AND status IN ('pending', 'sending') ORDER BY due_at, id`;
}

/** Cancels a pending reminder of the subject's own; null when they have no such reminder waiting. */
export async function cancelOwnReminder(sql: Sql, subject: Subject, reminderId: number): Promise<MemberReminder | null> {
  const [row] = await asSubject(sql, subject, (tx) => tx<MemberReminder[]>`
    UPDATE reminders SET status = 'cancelled', cancelled_at = now()
    WHERE id = ${reminderId} AND chat_id = ${subject.chatId} AND user_id = ${subject.userId} AND status = 'pending'
    RETURNING *`);
  return row ?? null;
}

/** Settles the subject's request: what it turned out to be, what became of it, and the bot's reply to it when there is one. */
export async function settleRequest(sql: Sql, subject: Subject, requestId: number, kind: string, status: string, receiptMsgId: number | null = null): Promise<void> {
  await asSubject(sql, subject, (tx) => tx`
    UPDATE self_edits SET kind = ${kind}, status = ${status}, receipt_msg_id = coalesce(${receiptMsgId}::bigint, receipt_msg_id), decided_at = now()
    WHERE id = ${requestId}`);
}

/** Marks the subject's request as one for a reminder while it is handled: the chronicler reads it as one, and a failure is told as a reminder's. */
export async function markReminderRequest(sql: Sql, subject: Subject, requestId: number): Promise<void> {
  await asSubject(sql, subject, (tx) => tx`UPDATE self_edits SET kind = 'reminder' WHERE id = ${requestId} AND status = 'parsing'`);
}

/**
 * The bot's reply to the subject's request, on the request and on the reminder it set; on the reminder alone while
 * the request waits for the card change the same message asks for (`requestId` null).
 */
export async function recordReceipt(sql: Sql, subject: Subject, requestId: number | null, receiptMsgId: number, reminderId?: number): Promise<void> {
  await asSubject(sql, subject, async (tx) => {
    if (requestId !== null) await tx`UPDATE self_edits SET receipt_msg_id = ${receiptMsgId} WHERE id = ${requestId}`;
    if (reminderId !== undefined) await tx`UPDATE reminders SET receipt_msg_id = ${receiptMsgId} WHERE id = ${reminderId} AND status = 'pending'`;
  });
}

// ---------- Delivery, under the app's own role ----------

/** How long a reminder waits after a failed try before the next: twice as long each time, at most an hour. */
export const RETRY_CAP_MINUTES = 60;

/**
 * Takes the reminders that are due, and those a crash left sending for over `staleMinutes`, in one statement: a row is
 * taken once however many ticks run, and every take counts as an attempt. One whose last try failed waits 2, 4, 8…
 * minutes, at most RETRY_CAP_MINUTES, so that an outage of Telegram or of the network does not use up its tries.
 */
export async function claimDueReminders(sql: Sql, limit: number, staleMinutes: number): Promise<MemberReminder[]> {
  const rows = await sql<MemberReminder[]>`
    UPDATE reminders SET status = 'sending', claimed_at = now(), attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM reminders
      WHERE (status = 'pending' AND due_at <= now()
             AND (claimed_at IS NULL OR claimed_at < now() - make_interval(mins => least(power(2, attempts), ${RETRY_CAP_MINUTES})::int)))
         OR (status = 'sending' AND claimed_at < now() - make_interval(mins => ${staleMinutes}))
      ORDER BY due_at, id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED)
    RETURNING *`;
  return [...rows].sort((a, b) => a.due_at.getTime() - b.due_at.getTime() || a.id - b.id);
}

/** Puts back reminders taken but never tried (the bot is stopping), as if they had not been taken. */
export async function releaseReminders(sql: Sql, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await sql`UPDATE reminders SET status = 'pending', attempts = attempts - 1, claimed_at = NULL WHERE id = ANY(${ids}::bigint[]) AND status = 'sending'`;
}

/** What went out, recorded the moment it did, so that place never gets the reminder again; or why the private chat did not take it. */
export async function recordDelivery(sql: Sql, id: number, delivered: { chatMsgId?: number; dmMsgId?: number; dmError?: string }): Promise<void> {
  await sql`
    UPDATE reminders SET chat_msg_id = coalesce(${delivered.chatMsgId ?? null}::bigint, chat_msg_id),
           dm_msg_id = coalesce(${delivered.dmMsgId ?? null}::bigint, dm_msg_id), dm_error = coalesce(${delivered.dmError ?? null}::text, dm_error)
    WHERE id = ${id}`;
}

/**
 * Ends a delivery: sent, back to waiting for the next try (from when this one was taken, as claimDueReminders counts),
 * failed, or cancelled (its member opted out meanwhile).
 */
export async function finishReminder(sql: Sql, id: number, status: Exclude<ReminderStatus, "sending">): Promise<void> {
  await sql`
    UPDATE reminders SET status = ${status},
           sent_at = CASE WHEN ${status}::text = 'sent' THEN now() ELSE sent_at END,
           cancelled_at = CASE WHEN ${status}::text = 'cancelled' THEN now() ELSE cancelled_at END
    WHERE id = ${id} AND status = 'sending'`;
}

/** Deletes reminders finished more than `days` ago: their text was a message of the chat, kept no longer than the chat's own. */
export async function clearFinishedReminders(sql: Sql, days: number): Promise<number> {
  const rows = await sql`
    DELETE FROM reminders
    WHERE status IN ('sent', 'cancelled', 'failed') AND coalesce(sent_at, cancelled_at, claimed_at, created_at) < now() - make_interval(days => ${days})
    RETURNING 1`;
  return rows.length;
}
