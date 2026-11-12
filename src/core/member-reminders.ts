import type { Sql } from "./db.js";
import { asSubject, type Subject } from "./own-card.js";

/**
 * Reminders members ask the bot for in a chat (migrations/013_reminders.sql), and the things they ask it to do for them
 * later, which wait in the same table as actions (migrations/014_scheduled_actions.sql). Whatever a request does with
 * them runs under the self-edit role, which row-level security confines to the asker's own rows in the asker's own chat
 * (asSubject): nobody adds, sees or cancels anyone else's, whatever a model or a message says. The worker
 * (src/worker/member-reminders.ts) claims and finishes them under the app's own role.
 */

/** Reminders and actions a member may have waiting in one chat, both kinds together. */
export const MAX_PENDING_REMINDERS = 20;
export const MAX_REMINDER_CHARS = 500;
/** How much of the message a request replied to an action keeps, when it keeps it at all. */
export const MAX_REPLY_CHARS = 3500;

export type ReminderStatus = "pending" | "sending" | "sent" | "cancelled" | "failed";
export type ReminderLanguage = "Russian" | "English";
/** A reminder the bot writes when it is due, or something the bot does then as if they had just asked. */
export type ReminderKind = "remind" | "action";

export interface MemberReminder {
  id: number;
  chat_id: number;
  user_id: number;
  kind: ReminderKind;
  /** What to remind of, or, for an action, what to do. */
  text: string;
  due_at: Date;
  time_zone: string;
  language: ReminderLanguage;
  source_msg_id: number;
  thread_id: number | null;
  /** The message an action's request replied to, with its text when it is the bot's own or the requester's own. */
  reply_to_msg_id: number | null;
  reply_text: string | null;
  reply_author: "bot" | "self" | null;
  /** The other members of the chat it reminds, tagging them there (migrations/017_reminders_for_others.sql). */
  for_user_ids: number[];
  /** Whether it reminds its asker too, in the chat and privately: always, for a reminder with nobody else in it. */
  for_asker: boolean;
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
  kind?: ReminderKind;
  text: string;
  dueAt: Date;
  timeZone: string;
  language: ReminderLanguage;
  sourceMsgId: number;
  threadId: number | null;
  /** The message an action's request replied to; its text only when it is the bot's own or the requester's own. */
  replyTo?: { msgId: number; kept: { text: string; author: "bot" | "self" } | null };
  /** Other members of the chat to remind, tagging them there, and whether the asker is reminded too. */
  forUserIds?: number[];
  forAsker?: boolean;
}

export type AddedReminder = { status: "added"; reminder: MemberReminder } | { status: "opted_out" } | { status: "too_many" } | { status: "handled_already" };

/** The subject's pending reminders in their chat, soonest first. */
export async function ownPendingReminders(sql: Sql, subject: Subject): Promise<MemberReminder[]> {
  return asSubject(sql, subject, (tx) => tx<MemberReminder[]>`
    SELECT * FROM reminders WHERE chat_id = ${subject.chatId} AND user_id = ${subject.userId} AND status = 'pending' ORDER BY due_at, id`);
}

/**
 * Adds a reminder or an action of the subject's own, in one transaction: one message sets one of each kind at most (an
 * action done at its time that sets a reminder answers the same message), someone who opted out gets none, and nobody
 * keeps more than MAX_PENDING_REMINDERS of both kinds in a chat. The request that asked for it is settled with it as
 * `settleAs`, unless that is null: the same message also asks for a change to their card, which settles it later.
 */
export async function addOwnReminder(sql: Sql, subject: Subject, reminder: NewReminder, requestId: number, settleAs: string | null = "reminder"): Promise<AddedReminder> {
  const kind = reminder.kind ?? "remind";
  return asSubject(sql, subject, async (tx): Promise<AddedReminder> => {
    const [member] = await tx<{ opted_out: boolean }[]>`SELECT opted_out FROM members WHERE chat_id = ${subject.chatId} AND user_id = ${subject.userId} FOR UPDATE`;
    if (member?.opted_out !== false) return { status: "opted_out" };
    const [pending] = await tx<{ count: number }[]>`
      SELECT count(*)::int AS count FROM reminders WHERE chat_id = ${subject.chatId} AND user_id = ${subject.userId} AND status = 'pending'`;
    if ((pending?.count ?? 0) >= MAX_PENDING_REMINDERS) return { status: "too_many" };
    const [request] = await tx`SELECT 1 FROM self_edits WHERE id = ${requestId} AND status = 'parsing' FOR UPDATE`;
    const [set] = await tx`
      SELECT 1 FROM reminders WHERE chat_id = ${subject.chatId} AND user_id = ${subject.userId} AND source_msg_id = ${reminder.sourceMsgId} AND kind = ${kind}`;
    if (!request || set) return { status: "handled_already" };
    if (settleAs !== null) await tx`UPDATE self_edits SET kind = ${settleAs}, status = 'applied', decided_at = now() WHERE id = ${requestId}`;
    const replyTo = reminder.replyTo;
    const [row] = await tx<MemberReminder[]>`
      INSERT INTO reminders (chat_id, user_id, kind, text, due_at, time_zone, language, source_msg_id, thread_id, reply_to_msg_id, reply_text, reply_author, for_user_ids, for_asker)
      VALUES (${subject.chatId}, ${subject.userId}, ${kind}, ${reminder.text}, ${reminder.dueAt}, ${reminder.timeZone}, ${reminder.language}, ${reminder.sourceMsgId},
              ${reminder.threadId}, ${replyTo?.msgId ?? null}, ${replyTo?.kept ? [...replyTo.kept.text].slice(0, MAX_REPLY_CHARS).join("") : null}, ${replyTo?.kept?.author ?? null},
              ${reminder.forUserIds ?? []}::int[], ${reminder.forAsker ?? true})
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

/** A member's reminders and actions still to come in a chat, soonest first: what the bot shows them it keeps about them. */
export async function waitingReminders(sql: Sql, chatId: number, userId: number): Promise<Pick<MemberReminder, "id" | "kind" | "due_at" | "text">[]> {
  return sql<Pick<MemberReminder, "id" | "kind" | "due_at" | "text">[]>`
    SELECT id, kind, due_at, text FROM reminders WHERE chat_id = ${chatId} AND user_id = ${userId} AND status IN ('pending', 'sending') ORDER BY due_at, id`;
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

/**
 * Marks the subject's request as one for a reminder, or for something to do later, while it is handled: the chronicler
 * reads it as one, and a failure is told as one.
 */
export async function markReminderRequest(sql: Sql, subject: Subject, requestId: number, kind = "reminder"): Promise<void> {
  await asSubject(sql, subject, (tx) => tx`UPDATE self_edits SET kind = ${kind} WHERE id = ${requestId} AND status = 'parsing'`);
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
 * Takes the reminders (of the given kinds) that are due, and those a crash left sending for over `staleMinutes`, in one
 * statement: a row is taken once however many ticks run, and every take counts as an attempt. One whose last try failed
 * waits 2, 4, 8… minutes, at most RETRY_CAP_MINUTES, so that an outage of Telegram or of the network does not use up its tries.
 */
export async function claimDueReminders(sql: Sql, limit: number, staleMinutes: number, kinds: ReminderKind[] = ["remind", "action"]): Promise<MemberReminder[]> {
  const rows = await sql<MemberReminder[]>`
    UPDATE reminders SET status = 'sending', claimed_at = now(), attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM reminders
      WHERE kind = ANY(${kinds}::text[])
        AND ((status = 'pending' AND due_at <= now()
              AND (claimed_at IS NULL OR claimed_at < now() - make_interval(mins => least(power(2, attempts), ${RETRY_CAP_MINUTES})::int)))
             OR (status = 'sending' AND claimed_at < now() - make_interval(mins => ${staleMinutes})))
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

/**
 * An action done at its time is on record in self_edits under this id: below every id a message has, and below every id
 * a chat's move to a supergroup gives its old messages ((-2^31, 0]), so it never meets the record of the request that
 * asked for it, which is keyed by that request's message.
 */
export const EXECUTION_ID_BASE = 2 ** 40;
export const executionMsgId = (reminderId: number) => -(EXECUTION_ID_BASE + reminderId);

/** Whether an action was started already: its record is there, made the moment it began. */
export async function executionStarted(sql: Sql, reminder: Pick<MemberReminder, "id" | "chat_id">): Promise<boolean> {
  const [row] = await sql`SELECT 1 FROM self_edits WHERE chat_id = ${reminder.chat_id} AND msg_id = ${executionMsgId(reminder.id)}`;
  return Boolean(row);
}

/**
 * Puts an action done outside the card requests (a command, or an answer where they do not run) on record as it starts,
 * as the card requests put theirs; false when it is there already, so the action is never done twice.
 */
export async function recordExecution(sql: Sql, reminder: Pick<MemberReminder, "id" | "chat_id" | "user_id" | "source_msg_id">, tgId: number, kind: string): Promise<boolean> {
  const rows = await sql`
    INSERT INTO self_edits (chat_id, msg_id, source_msg_id, user_id, tg_id, kind, status, decided_at)
    VALUES (${reminder.chat_id}, ${executionMsgId(reminder.id)}, ${reminder.source_msg_id}, ${reminder.user_id}, ${tgId}, ${kind}, 'answered', now())
    ON CONFLICT (chat_id, msg_id) DO NOTHING RETURNING id`;
  return rows.length > 0;
}

/** Deletes reminders finished more than `days` ago: their text was a message of the chat, kept no longer than the chat's own. */
export async function clearFinishedReminders(sql: Sql, days: number): Promise<number> {
  const rows = await sql`
    DELETE FROM reminders
    WHERE status IN ('sent', 'cancelled', 'failed') AND coalesce(sent_at, cancelled_at, claimed_at, created_at) < now() - make_interval(days => ${days})
    RETURNING 1`;
  return rows.length;
}
