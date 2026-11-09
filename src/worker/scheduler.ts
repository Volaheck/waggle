import type Anthropic from "@anthropic-ai/sdk";
import { approvedChats, type Chat } from "../core/chats.js";
import type { Config } from "../core/config.js";
import type { Sql } from "../core/db.js";
import { BudgetExceededError } from "../core/llm.js";
import { isConsolidationDue, runConsolidation } from "./consolidate.js";
import { isPassDue, lastSuccessfulRunAt, pendingStats, runExtractionPass } from "./extract.js";

export interface SchedulerOptions {
  sql: Sql;
  anthropic: Anthropic;
  config: Pick<Config, "EXTRACTION_MODEL" | "MONTHLY_LLM_BUDGET_USD" | "CHAT_MONTHLY_BUDGET_USD" | "EXTRACTION_INTERVAL_HOURS">;
  checkEveryMs?: number;
  notifyAdmins: (text: string) => Promise<void>;
  log?: (line: string) => void;
}

const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;
const ALERT_COOLDOWN_MS = 12 * 60 * 60 * 1000;

export function chatBudgetUsd(chat: Chat, fallback: number): number {
  return chat.monthly_budget_usd === null ? fallback : Number(chat.monthly_budget_usd);
}

/** Every few minutes: for each approved chat, run the chronicler when its interval passed, and the weekly clean-up. */
export function startExtractionScheduler(options: SchedulerOptions): () => void {
  const { sql, config } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const lastAlertAt = new Map<string, number>();
  let running = false;

  const alertOnce = async (key: string, text: string) => {
    if (Date.now() - (lastAlertAt.get(key) ?? 0) < ALERT_COOLDOWN_MS) return;
    lastAlertAt.set(key, Date.now());
    await options.notifyAdmins(text).catch((error) => log(`[extract] could not notify admins: ${String(error)}`));
  };

  const processChat = async (chat: Chat) => {
    const chatUsd = chatBudgetUsd(chat, config.CHAT_MONTHLY_BUDGET_USD);
    const title = chat.title ?? String(chat.id);
    try {
      const [lastAttempt] = await sql<{ started_at: Date; status: string }[]>`
        SELECT started_at, status FROM extraction_runs WHERE chat_id = ${chat.id} ORDER BY id DESC LIMIT 1`;
      if (lastAttempt?.status === "failed" && Date.now() - lastAttempt.started_at.getTime() < RETRY_AFTER_FAILURE_MS) return;

      const pending = await pendingStats(sql, chat.id);
      if (isPassDue(pending, await lastSuccessfulRunAt(sql, chat.id), config.EXTRACTION_INTERVAL_HOURS)) {
        const result = await runExtractionPass({ sql, anthropic: options.anthropic, chatId: chat.id, chatBudgetUsd: chatUsd, config });
        log(
          `[extract] ${title}: ${result.messages} messages in ${result.calls} call(s): ${result.topics} topics, facts +${result.factsAdded} ↑${result.factsReinforced} ✎${result.factsUpdated}, projects +${result.projectsCreated} ~${result.projectsUpdated}`,
        );
      }

      if (await isConsolidationDue(sql, chat.id)) {
        const cleaned = await runConsolidation(sql, options.anthropic, config.EXTRACTION_MODEL, {
          totalUsd: config.MONTHLY_LLM_BUDGET_USD,
          chatId: chat.id,
          chatUsd,
        });
        log(`[consolidate] ${title}: merged ${cleaned.factsMerged} facts, dropped ${cleaned.factsDropped}, merged ${cleaned.projectsMerged} projects, updated ${cleaned.projectsUpdated}`);
      }
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        const where = error.chatId === undefined ? "in all chats" : `in “${title}”`;
        await alertOnce(`budget:${error.chatId ?? "all"}`, `⚠️ ${error.message}. The chronicle and cards ${where} are paused until next month or until you raise the limit.`);
      } else {
        log(`[extract] ${title} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        await alertOnce(`error:${chat.id}`, `⚠️ Failed to process messages in “${title}”: ${error instanceof Error ? error.message : String(error)}. Will retry in an hour.`);
      }
    }
  };

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const chat of await approvedChats(sql)) await processChat(chat);
    } catch (error) {
      log(`[extract] tick failed: ${String(error)}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), options.checkEveryMs ?? 5 * 60_000);
  void tick();
  return () => clearInterval(timer);
}
