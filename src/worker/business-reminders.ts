import type Anthropic from "@anthropic-ai/sdk";
import { InlineKeyboard, type Api } from "grammy";
import { z } from "zod";
import {
  activeReminders,
  addDays,
  addReminder,
  chatsToRead,
  clearOldDialogue,
  closeReminders,
  dialogueFor,
  dueReminders,
  localDate,
  localTime,
  markRead,
  scheduleFor,
  setReminderStatus,
  spentOnRemindersUsd,
  weekdayOf,
  type PendingChat,
  type Reminder,
} from "../core/business-reminders.js";
import type { Config } from "../core/config.js";
import type { Sql } from "../core/db.js";
import { callStructured, chatEndUserId, monthSpendUsd, recordUsage } from "../core/llm.js";
import { maskPersonalData } from "../core/privacy.js";
import { escapeHtml, truncate } from "../core/text.js";
import { formatDate } from "../bot/format.js";

export const REMINDERS_PURPOSE = "business_reminders";
const TICK_MS = 60 * 1000;
/** A conversation is read once it has been quiet this long… */
const IDLE_MINUTES = 10;
/** …or once its oldest unread line has waited this long, however lively it is. */
const MAX_WAIT_MINUTES = 60;
const LINES_PER_CALL = 200;
const CONTEXT_LINES = 12;
const LINE_MAX_CHARS = 500;
const CALENDAR_DAYS = 21;
/** After a failed call the chat waits this long before the next try. */
const RETRY_AFTER_MS = 10 * 60 * 1000;

export const REMINDERS_SYSTEM_PROMPT = `You read a private Telegram conversation between the owner of the account ("me") and one other person, and find the concrete commitments in the new messages that are worth a reminder.

- promise: someone firmly committed to do a specific thing ("I'll send you the contract tomorrow", "скину вечером", "завтра позвоню"). by: "me" when the owner committed, "them" when the other person did.
- plan: an agreed meeting, call, trip or event with a day ("let's meet on Thursday at 7", "созвонимся в пятницу"). by: "both".

Only firm, specific commitments made in <new_messages>. Skip vague intentions ("we should grab a coffee sometime"), questions and offers nobody accepted, jokes, anything already done, and anything that only appears in <context>.

date: the local calendar date it is due, taken from <calendar> ("tomorrow", "on Friday", "next week Monday"); null only for a promise with no day at all. time: local HH:MM when stated or clearly implied ("in the evening" 19:00, "in the morning" 10:00, "at lunch" 13:00, "after work" 18:30), otherwise null.
what: a short phrase in the conversation's language saying what is to be done, without the date or time and without the person's name ("скинуть договор", "созвон по проекту").
source: the id of the message with the commitment, such as m123.

<open_reminders> lists what is already being tracked for this chat. Never add one of them again. Put its id (such as r7) in resolved when the new messages show it was done or cancelled, or that it moved to another time; for a move, also add the new version as an item.

Return empty lists when there is nothing.`;

export const RemindersResultSchema = z.object({
  items: z.array(
    z.object({
      kind: z.enum(["promise", "plan"]),
      by: z.enum(["me", "them", "both"]),
      what: z.string(),
      date: z.string().nullable(),
      time: z.string().nullable(),
      source: z.string(),
    }),
  ),
  resolved: z.array(z.string()),
});
export type RemindersResult = z.infer<typeof RemindersResultSchema>;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function promptLine(line: { msg_id: number; from_owner: boolean; chat_name: string; text: string; sent_at: Date }, timeZone: string): string {
  const who = line.from_owner ? "me" : line.chat_name;
  const text = maskPersonalData(truncate(line.text.replace(/\s+/g, " ").trim(), LINE_MAX_CHARS));
  return `[m${line.msg_id} ${localDate(line.sent_at, timeZone)} ${localTime(line.sent_at, timeZone)}] ${who}: ${text}`;
}

function reminderPromptLine(reminder: Reminder, timeZone: string): string {
  const due = reminder.due_at ? `${localDate(reminder.due_at, timeZone)}${reminder.due_has_time ? ` ${localTime(reminder.due_at, timeZone)}` : ""}` : "no date";
  return `[r${reminder.id}] ${reminder.kind} by ${reminder.committed_by}: ${reminder.what} — ${due}`;
}

export function remindersPrompt(data: {
  now: Date;
  timeZone: string;
  otherPerson: string;
  open: Reminder[];
  context: Parameters<typeof promptLine>[0][];
  pending: Parameters<typeof promptLine>[0][];
}): string {
  const today = localDate(data.now, data.timeZone);
  const calendar = Array.from({ length: CALENDAR_DAYS }, (_, index) => {
    const date = addDays(today, index);
    const weekday = weekdayOf(new Date(`${date}T12:00:00Z`), "UTC");
    return `${date} ${weekday}${index === 0 ? " (today)" : index === 1 ? " (tomorrow)" : ""}`;
  });
  return [
    `<now>${today} ${localTime(data.now, data.timeZone)}, ${data.timeZone}</now>`,
    `<calendar>\n${calendar.join("\n")}\n</calendar>`,
    `<other_person>${maskPersonalData(data.otherPerson)}</other_person>`,
    `<open_reminders>\n${data.open.map((reminder) => reminderPromptLine(reminder, data.timeZone)).join("\n") || "(none)"}\n</open_reminders>`,
    `<context>\n${data.context.map((line) => promptLine(line, data.timeZone)).join("\n") || "(none)"}\n</context>`,
    `<new_messages>\n${data.pending.map((line) => promptLine(line, data.timeZone)).join("\n")}\n</new_messages>`,
  ].join("\n\n");
}

export function reminderLine(reminder: Pick<Reminder, "kind" | "committed_by" | "chat_name" | "what" | "due_at" | "due_has_time">, timeZone: string): string {
  const name = `<b>${escapeHtml(reminder.chat_name)}</b>`;
  const what = escapeHtml(reminder.what);
  const head =
    reminder.kind === "plan" ? `Plan with ${name}: ${what}` : reminder.committed_by === "them" ? `${name} promised you: ${what}` : `You promised ${name}: ${what}`;
  return reminder.due_at ? `${head} · ${formatDate(reminder.due_at, timeZone, reminder.due_has_time)}` : head;
}

export const reminderButtons = (id: number) =>
  new InlineKeyboard().text("✅ Done", `bzr:done:${id}`).text("⏰ In 1 h", `bzr:hour:${id}`).text("📅 Tomorrow", `bzr:tomorrow:${id}`);

export interface RemindersDeps {
  sql: Sql;
  anthropic: Anthropic;
  api: Api;
  config: Pick<Config, "BOT_TOKEN" | "ADMIN_TG_IDS" | "DISPLAY_TIMEZONE" | "MONTHLY_LLM_BUDGET_USD" | "BUSINESS_REMINDER_MODEL" | "BUSINESS_REMINDERS_MONTHLY_BUDGET_USD">;
  log?: (line: string) => void;
  now?: () => Date;
}

/** Reads one chat's unread lines and records the reminders found in them; false when the call failed and should be retried later. */
export async function readChat(deps: RemindersDeps, chat: PendingChat): Promise<boolean> {
  const { sql, config } = deps;
  const log = deps.log ?? ((line: string) => console.log(line));
  const timeZone = config.DISPLAY_TIMEZONE;
  const now = deps.now?.() ?? new Date();
  const { pending, context } = await dialogueFor(sql, chat.connection_id, chat.chat_id, { pending: LINES_PER_CALL, context: CONTEXT_LINES });
  if (pending.length === 0) return true;
  const msgIds = pending.map((line) => line.msg_id);
  const open = await activeReminders(sql, chat.connection_id, chat.chat_id);
  const otherPerson = pending.at(-1)!.chat_name;
  const outcome = await callStructured(deps.anthropic, {
    model: config.BUSINESS_REMINDER_MODEL,
    maxTokens: 2000,
    system: REMINDERS_SYSTEM_PROMPT,
    prompt: remindersPrompt({ now, timeZone, otherPerson, open, context, pending }),
    schema: RemindersResultSchema,
    onUsage: (usage) => recordUsage(sql, REMINDERS_PURPOSE, config.BUSINESS_REMINDER_MODEL, usage),
    endUserId: chatEndUserId(config.BOT_TOKEN, chat.owner_chat_id),
  });
  if (!outcome.ok) {
    // A refusal or a broken answer would come back the same: these lines are not read again.
    log(`[reminders] could not read a chat (${outcome.message}); skipped ${pending.length} line(s)`);
    await markRead(sql, chat.connection_id, chat.chat_id, msgIds);
    return true;
  }
  const openIds = new Set(open.map((reminder) => reminder.id));
  const resolved = outcome.data.resolved.map((ref) => Number(ref.replace(/^r/, ""))).filter((id) => openIds.has(id));
  await closeReminders(sql, chat.connection_id, chat.chat_id, resolved, "done");
  const knownMsgIds = new Set(msgIds);
  for (const item of outcome.data.items) {
    const what = item.what.trim();
    if (!what) continue;
    const date = item.date && DATE.test(item.date) ? item.date : null;
    const time = date && item.time && TIME.test(item.time) ? item.time : null;
    const by = item.kind === "plan" ? "both" : item.by === "both" ? "me" : item.by;
    const schedule = scheduleFor({ kind: item.kind, by, date, time }, now, timeZone);
    if (!schedule) continue;
    const sourceMsgId = Number(item.source.replace(/^m/, ""));
    const reminder = await addReminder(sql, {
      connection_id: chat.connection_id,
      chat_id: chat.chat_id,
      chat_name: otherPerson,
      kind: item.kind,
      committed_by: by,
      what: truncate(what, 200),
      due_at: schedule.dueAt,
      due_has_time: schedule.dueHasTime,
      remind_at: schedule.remindAt,
      source_msg_id: knownMsgIds.has(sourceMsgId) ? sourceMsgId : null,
    });
    await deps.api
      .sendMessage(chat.owner_chat_id, `📝 Noted. ${reminderLine(reminder, timeZone)}\nI'll remind you ${formatDate(reminder.remind_at, timeZone)}.`, {
        parse_mode: "HTML",
        disable_notification: true,
        reply_markup: new InlineKeyboard().text("✖ Not needed", `bzr:drop:${reminder.id}`),
      })
      .catch((error: unknown) => log(`[reminders] could not tell the owner about a new reminder: ${String(error)}`));
  }
  await markRead(sql, chat.connection_id, chat.chat_id, msgIds);
  return true;
}

export async function sendDueReminders(deps: RemindersDeps): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  let sent = 0;
  for (const reminder of await dueReminders(deps.sql)) {
    if (!deps.config.ADMIN_TG_IDS.includes(reminder.owner_tg_id)) {
      await setReminderStatus(deps.sql, reminder.id, "dropped");
      continue;
    }
    // Marked first: a reminder that cannot be delivered is not retried every minute.
    await setReminderStatus(deps.sql, reminder.id, "sent");
    try {
      await deps.api.sendMessage(reminder.owner_chat_id, `⏰ ${reminderLine(reminder, deps.config.DISPLAY_TIMEZONE)}`, {
        parse_mode: "HTML",
        reply_markup: reminderButtons(reminder.id),
      });
      sent += 1;
    } catch (error) {
      log(`[reminders] could not send reminder ${reminder.id}: ${String(error)}`);
    }
  }
  return sent;
}

async function withinBudget(deps: RemindersDeps): Promise<boolean> {
  const { sql, config } = deps;
  if ((await spentOnRemindersUsd(sql, REMINDERS_PURPOSE)) >= config.BUSINESS_REMINDERS_MONTHLY_BUDGET_USD) return false;
  return (await monthSpendUsd(sql)) < config.MONTHLY_LLM_BUDGET_USD;
}

/** Every minute: delivers the reminders that are due, then reads the conversations that are ready. */
export function startBusinessReminders(deps: RemindersDeps): () => Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const retryAt = new Map<string, number>();
  let running: Promise<void> | undefined;
  let stopped = false;
  let budgetToldMonth: string | undefined;

  const tick = async () => {
    try {
      await sendDueReminders(deps);
      await clearOldDialogue(deps.sql);
      for (const chat of await chatsToRead(deps.sql, IDLE_MINUTES, MAX_WAIT_MINUTES)) {
        if (stopped) return;
        if (!deps.config.ADMIN_TG_IDS.includes(chat.owner_tg_id)) continue;
        const key = `${chat.connection_id}:${chat.chat_id}`;
        if ((retryAt.get(key) ?? 0) > Date.now()) continue;
        if (!(await withinBudget(deps))) {
          const month = new Date().toISOString().slice(0, 7);
          if (budgetToldMonth !== month) log("[reminders] the monthly cap is used up; conversations wait until next month or a higher cap");
          budgetToldMonth = month;
          return;
        }
        try {
          await readChat(deps, chat);
          retryAt.delete(key);
        } catch (error) {
          retryAt.set(key, Date.now() + RETRY_AFTER_MS);
          log(`[reminders] reading a chat failed, retrying later: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      log(`[reminders] tick failed: ${error instanceof Error ? error.message : String(error)}`);
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
