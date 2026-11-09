import type Anthropic from "@anthropic-ai/sdk";
import { approvedChats, type Chat } from "../core/chats.js";
import type { Config } from "../core/config.js";
import type { Sql } from "../core/db.js";
import { BudgetExceededError } from "../core/llm.js";
import { clearExpiredTexts } from "../core/messages.js";
import { isConsolidationDue, nextConsolidationRetryAt, runConsolidation } from "./consolidate.js";
import { isPassDue, lastSuccessfulRunAt, pendingStats, runExtractionPass } from "./extract.js";

export interface SchedulerOptions {
  sql: Sql;
  anthropic: Anthropic;
  config: Pick<Config, "EXTRACTION_MODEL" | "MONTHLY_LLM_BUDGET_USD" | "CHAT_MONTHLY_BUDGET_USD" | "EXTRACTION_INTERVAL_HOURS"> & Partial<Pick<Config, "ADMIN_TG_IDS">>;
  checkEveryMs?: number;
  notifyAdmins: (text: string) => Promise<void>;
  log?: (line: string) => void;
}

const HOUR_MS = 60 * 60 * 1000;
const MAX_RETRY_MS = 24 * HOUR_MS;
const ALERT_COOLDOWN_MS = 12 * HOUR_MS;
const RETENTION_CHECK_MS = HOUR_MS;

export function chatBudgetUsd(chat: Chat, fallback: number): number {
  return chat.monthly_budget_usd === null ? fallback : Number(chat.monthly_budget_usd);
}

/** After a failed chronicler pass: 1 h, then 2 h, 4 h… and at most a day between attempts. */
export function extractionRetryDelayMs(consecutiveFailures: number): number {
  return Math.min(MAX_RETRY_MS, HOUR_MS * 2 ** Math.max(0, consecutiveFailures - 1));
}

/** When the chronicler may try a chat again after failed passes; null when the last pass did not fail. */
export async function nextExtractionRetryAt(sql: Sql, chatId: number): Promise<Date | null> {
  const runs = await sql<{ started_at: Date; status: string }[]>`
    SELECT started_at, status FROM extraction_runs WHERE chat_id = ${chatId} AND status <> 'running' ORDER BY id DESC LIMIT 12`;
  const failures = runs.findIndex((run) => run.status !== "failed");
  const count = failures === -1 ? runs.length : failures;
  return count === 0 ? null : new Date(runs[0]!.started_at.getTime() + extractionRetryDelayMs(count));
}

function retryText(at: Date | null): string {
  if (!at) return "I'll try again later.";
  const hours = Math.max(1, Math.round((at.getTime() - Date.now()) / HOUR_MS));
  return hours < 48 ? `Next attempt in about ${hours} h.` : `Next attempt in about ${Math.round(hours / 24)} days.`;
}

/** How a stop reaches the work under way. */
export interface StopSignals {
  /** The scheduler is stopping: no new LLM call starts. */
  drain: AbortSignal;
  /** The stop cannot wait any longer: the call under way is cancelled. */
  abort: AbortSignal;
}

/**
 * Handles one chat: the chronicler when its interval passed, then the weekly clean-up. Each step
 * has its own error handling and back-off, so a chronicler that keeps failing does not hold up the
 * clean-up, and a failure is never retried on every tick. Work cut off by a stop is retried after
 * the restart, with no alert.
 */
export function createChatProcessor(options: SchedulerOptions, signals?: StopSignals): (chat: Chat) => Promise<void> {
  const { sql, config } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const lastAlertAt = new Map<string, number>();
  const stopping = () => signals?.drain.aborted ?? false;

  const alertOnce = async (key: string, text: string) => {
    if (Date.now() - (lastAlertAt.get(key) ?? 0) < ALERT_COOLDOWN_MS) return;
    lastAlertAt.set(key, Date.now());
    await options.notifyAdmins(text).catch((error) => log(`[extract] could not notify admins: ${String(error)}`));
  };

  const reportBudget = (error: BudgetExceededError, title: string) => {
    const where = error.chatId === undefined ? "in all chats" : `in “${title}”`;
    return alertOnce(`budget:${error.chatId ?? "all"}`, `⚠️ ${error.message}. The chronicle and cards ${where} are paused until next month or until you raise the limit.`);
  };

  return async (chat: Chat) => {
    const chatUsd = chatBudgetUsd(chat, config.CHAT_MONTHLY_BUDGET_USD);
    const title = chat.title ?? String(chat.id);

    try {
      const retryAt = await nextExtractionRetryAt(sql, chat.id);
      const pending = await pendingStats(sql, chat.id);
      if (
        !stopping() &&
        (!retryAt || retryAt.getTime() <= Date.now()) &&
        isPassDue(pending, await lastSuccessfulRunAt(sql, chat.id), config.EXTRACTION_INTERVAL_HOURS)
      ) {
        const result = await runExtractionPass({
          sql,
          anthropic: options.anthropic,
          chatId: chat.id,
          chatBudgetUsd: chatUsd,
          config,
          drain: signals?.drain,
          signal: signals?.abort,
        });
        log(
          `[extract] ${title}: ${result.messages} messages in ${result.calls} call(s): ${result.topics} topics, facts +${result.factsAdded} ↑${result.factsReinforced} ✎${result.factsUpdated}, projects +${result.projectsCreated} ~${result.projectsUpdated}`,
        );
        if (result.skipped.length) {
          const ranges = result.skipped.map((range) => `${range.firstMsgId}–${range.lastMsgId} (${range.reason})`).join("; ");
          log(`[extract] ${title}: skipped messages ${ranges}`);
          const count = result.skipped.reduce((sum, range) => sum + range.messages, 0);
          await alertOnce(`skipped:${chat.id}`, `⚠️ The chronicler could not process ${count} message(s) in “${title}” and skipped them so the rest of the chat is not held up: ${ranges}.`);
        }
      }
    } catch (error) {
      if (error instanceof BudgetExceededError) await reportBudget(error, title);
      else if (stopping()) log(`[extract] ${title}: the pass was cut off by the stop; it continues after the restart`);
      else {
        log(`[extract] ${title} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        const retryAt = await nextExtractionRetryAt(sql, chat.id).catch(() => null);
        await alertOnce(`error:${chat.id}`, `⚠️ Failed to process messages in “${title}”: ${error instanceof Error ? error.message : String(error)}. ${retryText(retryAt)}`);
      }
    }

    try {
      if (!stopping() && (await isConsolidationDue(sql, chat.id))) {
        const cleaned = await runConsolidation(
          sql,
          options.anthropic,
          config.EXTRACTION_MODEL,
          { totalUsd: config.MONTHLY_LLM_BUDGET_USD, chatId: chat.id, chatUsd },
          signals?.abort,
        );
        log(`[consolidate] ${title}: merged ${cleaned.factsMerged} facts, dropped ${cleaned.factsDropped}, merged ${cleaned.projectsMerged} projects, updated ${cleaned.projectsUpdated}`);
      }
    } catch (error) {
      if (error instanceof BudgetExceededError) await reportBudget(error, title);
      else if (stopping()) log(`[consolidate] ${title}: the clean-up was cut off by the stop; it runs again after the restart`);
      else {
        log(`[consolidate] ${title} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        const retryAt = await nextConsolidationRetryAt(sql, chat.id).catch(() => null);
        await alertOnce(`cleanup:${chat.id}`, `⚠️ The weekly card clean-up failed in “${title}”: ${error instanceof Error ? error.message : String(error)}. ${retryText(retryAt)}`);
      }
    }
  };
}

/**
 * Clears the texts of processed messages older than `retentionDays` (see clearExpiredTexts): at once, then every hour.
 * It runs whether the chronicler is on or not. Returns a function that stops it.
 */
export function startMessageRetention(sql: Sql, retentionDays: number, log: (line: string) => void = (line) => console.log(line)): () => void {
  const run = async () => {
    try {
      const cleared = await clearExpiredTexts(sql, retentionDays);
      if (cleared) log(`[retention] cleared the text of ${cleared} processed message(s) older than ${retentionDays} days`);
    } catch (error) {
      log(`[retention] failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  void run();
  const timer = setInterval(() => void run(), RETENTION_CHECK_MS);
  return () => clearInterval(timer);
}

/**
 * Every few minutes: for each approved chat, run the chronicler when its interval passed, and the weekly clean-up.
 * The returned stop function starts no new work, not even another call of a pass under way, and resolves once the
 * work under way is finished. Given `graceMs`, a call still running after that long is cancelled (its usage so far
 * is recorded) and the stop resolves once the work has wound down.
 */
export function startExtractionScheduler(options: SchedulerOptions): (graceMs?: number) => Promise<void> {
  const log = options.log ?? ((line: string) => console.log(line));
  const drain = new AbortController();
  const abort = new AbortController();
  const processChat = createChatProcessor(options, { drain: drain.signal, abort: abort.signal });
  let stopped = false;
  let current: Promise<void> | undefined;

  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    current ??= (async () => {
      try {
        for (const chat of await approvedChats(options.sql)) {
          if (stopped) break;
          await processChat(chat);
        }
      } catch (error) {
        log(`[extract] tick failed: ${String(error)}`);
      } finally {
        current = undefined;
      }
    })();
    return current;
  };

  const timer = setInterval(() => void tick(), options.checkEveryMs ?? 5 * 60_000);
  void tick();
  return async (graceMs) => {
    stopped = true;
    drain.abort();
    clearInterval(timer);
    const work = current;
    if (!work) return;
    if (graceMs === undefined) return work;
    let grace: NodeJS.Timeout | undefined;
    const finished = await Promise.race([work.then(() => true), new Promise<false>((resolve) => (grace = setTimeout(() => resolve(false), graceMs)))]);
    clearTimeout(grace);
    if (finished) return;
    log(`[extract] still busy after ${Math.round(graceMs / 1000)} s of the stop; cancelling the call under way`);
    abort.abort();
    await work;
  };
}
