import { GrammyError, type Api } from "grammy";
import { chatReminderText, privateReminderText } from "../bot/reminders.js";
import type { Config } from "../core/config.js";
import type { Sql } from "../core/db.js";
import { claimDueReminders, clearFinishedReminders, finishReminder, recordDelivery, releaseReminders, type MemberReminder, type ReminderStatus } from "../core/member-reminders.js";

/**
 * Delivers the reminders members asked for (src/bot/reminders.ts) once they are due: in their private chat with the
 * bot when they started it there, and in the chat, as a reply to their request that mentions them. Every tick takes the
 * due ones in one statement, so a reminder is taken once however the ticks run, and takes again what a crash left half
 * sent. Each place is recorded the moment a reminder goes out there and never gets it again; a failure Telegram may get
 * over (the network, a flood wait, its own errors) in either place leaves the reminder for a later tick, after a wait
 * that doubles with every try (src/core/member-reminders.ts), which tries only the place still missing: MAX_ATTEMPTS
 * tries in all, some three hours of them. A reminder counts as sent once either place took it, and its receipt loses
 * the cancel button then.
 */

const TICK_MS = 30_000;
const BATCH = 50;
/** A reminder left sending this long was cut off by a crash: it is taken again. */
const STALE_MINUTES = 10;
export const MAX_ATTEMPTS = 8;
const CLEAR_EVERY_MS = 3_600_000;

export interface MemberRemindersDeps {
  sql: Sql;
  api: Api;
  botUsername: string;
  /** Finished reminders are deleted as long after they finished as the chat keeps message texts. */
  config: Pick<Config, "MESSAGE_RETENTION_DAYS">;
  log?: (line: string) => void;
  now?: () => Date;
}

interface Recipient {
  tg_id: number | null;
  display_name: string;
  dm_started: boolean;
  opted_out: boolean | null;
  left_at: Date | null;
  chat_status: string | null;
  chat_title: string | null;
}

/** A failure Telegram may get over: the network, a flood wait, an error on its side. */
const passing = (error: unknown) => !(error instanceof GrammyError) || error.error_code === 429 || error.error_code >= 500;
/** The forum topic the request was asked in is gone or closed: the chat still takes the reminder outside it. */
const topicGone = (error: unknown) => error instanceof GrammyError && error.error_code === 400 && /thread|topic/i.test(error.description);
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function deliver(deps: MemberRemindersDeps, reminder: MemberReminder): Promise<Exclude<ReminderStatus, "sending">> {
  const { sql, api } = deps;
  const log = deps.log ?? ((line: string) => console.log(line));
  if (reminder.attempts > MAX_ATTEMPTS) return reminder.chat_msg_id !== null || reminder.dm_msg_id !== null ? "sent" : "failed";
  const [to] = await sql<Recipient[]>`
    SELECT u.tg_id, u.display_name, u.dm_started, m.opted_out, m.left_at, c.status AS chat_status, c.title AS chat_title
    FROM users u
    LEFT JOIN members m ON m.chat_id = ${reminder.chat_id} AND m.user_id = u.id
    LEFT JOIN chats c ON c.id = ${reminder.chat_id}
    WHERE u.id = ${reminder.user_id}`;
  // Opting out deletes a member's reminders; one that was on its way meanwhile goes nowhere either.
  if (!to?.tg_id || to.opted_out !== false) return "cancelled";
  const tgId = to.tg_id;
  const lateMs = (deps.now?.() ?? new Date()).getTime() - reminder.due_at.getTime();
  let retry = false;

  let dmMsgId = reminder.dm_msg_id;
  let dmError = reminder.dm_error;
  if (dmMsgId === null && dmError === null && to.dm_started) {
    const outcome = await sendOnce(() =>
      api.sendMessage(
        tgId,
        privateReminderText({ chatId: reminder.chat_id, chatTitle: to.chat_title, sourceMsgId: reminder.source_msg_id, text: reminder.text, lateMs, language: reminder.language }),
        { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
      ),
    );
    if ("msgId" in outcome) {
      dmMsgId = outcome.msgId;
      await recordDelivery(sql, reminder.id, { dmMsgId });
    } else {
      log(`[reminder delivery] reminder ${reminder.id}: the private chat did not take it: ${describe(outcome.error)}`);
      if (passing(outcome.error)) retry = true;
      else {
        dmError = describe(outcome.error);
        await recordDelivery(sql, reminder.id, { dmError });
        // The person blocked the bot or never started it: as everywhere else, it stops writing to them privately.
        if (outcome.error instanceof GrammyError && outcome.error.error_code === 403) await sql`UPDATE users SET dm_started = false WHERE id = ${reminder.user_id}`;
      }
    }
  }

  let chatMsgId = reminder.chat_msg_id;
  if (chatMsgId === null && to.chat_status === "approved" && to.left_at === null) {
    const text = chatReminderText({ tgId, name: to.display_name, text: reminder.text, lateMs, privateMissed: dmMsgId === null && dmError !== null, botUsername: deps.botUsername, language: reminder.language });
    const inTopic = reminder.thread_id !== null && reminder.thread_id > 0;
    // Where it was asked: in its topic, as a reply to the request. Messages kept from before a group became a supergroup
    // have ids below zero and nothing to reply to; outside the topic, a reply to the request would go back into it.
    const send = (whereAsked: boolean) =>
      sendOnce(() =>
        api.sendMessage(reminder.chat_id, text, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          ...(whereAsked && inTopic ? { message_thread_id: reminder.thread_id! } : {}),
          ...(whereAsked && reminder.source_msg_id > 0 ? { reply_parameters: { message_id: reminder.source_msg_id, allow_sending_without_reply: true } } : {}),
        }),
      );
    let outcome = await send(true);
    if ("error" in outcome && inTopic && topicGone(outcome.error)) {
      log(`[reminder delivery] reminder ${reminder.id}: its topic did not take it (${describe(outcome.error)}); posting it outside the topic`);
      outcome = await send(false);
    }
    if ("msgId" in outcome) {
      chatMsgId = outcome.msgId;
      await recordDelivery(sql, reminder.id, { chatMsgId });
    } else {
      log(`[reminder delivery] reminder ${reminder.id}: the chat did not take it: ${describe(outcome.error)}`);
      if (passing(outcome.error)) retry = true;
    }
  }

  // The place that missed it gets another try while tries are left; the one that took it is never tried again.
  if (retry && reminder.attempts < MAX_ATTEMPTS) return "pending";
  return chatMsgId !== null || dmMsgId !== null ? "sent" : "failed";
}

/** A sent reminder's receipt keeps its text and loses its cancel button, which would only say it is too late. */
async function retireReceipt(api: Api, reminder: MemberReminder): Promise<void> {
  if (reminder.receipt_msg_id === null || reminder.receipt_msg_id <= 0) return;
  await api.editMessageReplyMarkup(reminder.chat_id, reminder.receipt_msg_id).catch(() => {});
}

/** One message to Telegram: the id it got, or why Telegram did not take it. */
async function sendOnce(send: () => Promise<{ message_id: number }>): Promise<{ msgId: number } | { error: unknown }> {
  try {
    return { msgId: (await send()).message_id };
  } catch (error) {
    return { error };
  }
}

/** Delivers what is due now; `stopping` puts back what is left untried once the bot is stopping. */
export async function deliverDueReminders(deps: MemberRemindersDeps, stopping: () => boolean = () => false): Promise<Record<Exclude<ReminderStatus, "sending">, number>> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const counts = { pending: 0, sent: 0, cancelled: 0, failed: 0 };
  const claimed = await claimDueReminders(deps.sql, BATCH, STALE_MINUTES);
  for (const [index, reminder] of claimed.entries()) {
    if (stopping()) {
      await releaseReminders(deps.sql, claimed.slice(index).map((left) => left.id));
      break;
    }
    // A failure here (the database, say) leaves the reminder sending, and the next ticks take it again after STALE_MINUTES.
    const status = await deliver(deps, reminder).catch((error: unknown) => {
      log(`[reminder delivery] reminder ${reminder.id} failed on the bot's side: ${describe(error)}`);
      return undefined;
    });
    if (status === undefined) continue;
    await finishReminder(deps.sql, reminder.id, status);
    if (status === "sent") await retireReceipt(deps.api, reminder);
    counts[status] += 1;
    if (status === "failed") log(`[reminder delivery] reminder ${reminder.id} could not be delivered after ${reminder.attempts} attempt(s)`);
  }
  return counts;
}

/** Every 30 seconds: delivers the reminders that are due; once an hour, deletes those finished long enough ago. */
export function startMemberReminders(deps: MemberRemindersDeps): () => Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  let running: Promise<void> | undefined;
  let stopped = false;
  let clearedAt = 0;

  const tick = async () => {
    try {
      await deliverDueReminders(deps, () => stopped);
      if (!stopped && Date.now() - clearedAt >= CLEAR_EVERY_MS) {
        clearedAt = Date.now();
        await clearFinishedReminders(deps.sql, deps.config.MESSAGE_RETENTION_DAYS);
      }
    } catch (error) {
      log(`[reminder delivery] tick failed: ${describe(error)}`);
    }
  };

  const timer = setInterval(() => {
    if (!running && !stopped) running = tick().finally(() => (running = undefined));
  }, TICK_MS);
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
