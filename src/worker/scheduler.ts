import { BudgetExceededError } from "../core/llm.js";
import { isConsolidationDue, runConsolidation } from "./consolidate.js";
import { isPassDue, lastSuccessfulRunAt, pendingStats, runExtractionPass, type ExtractorDeps } from "./extract.js";

export interface SchedulerOptions extends ExtractorDeps {
  intervalHours: number;
  checkEveryMs?: number;
  notifyAdmins: (text: string) => Promise<void>;
  log?: (line: string) => void;
}

const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;
const ALERT_COOLDOWN_MS = 12 * 60 * 60 * 1000;

export function startExtractionScheduler(options: SchedulerOptions): () => void {
  const log = options.log ?? ((line: string) => console.log(line));
  let running = false;
  let lastAlertAt = 0;

  const alertOnce = async (text: string) => {
    if (Date.now() - lastAlertAt < ALERT_COOLDOWN_MS) return;
    lastAlertAt = Date.now();
    await options.notifyAdmins(text).catch((error) => log(`[extract] could not notify admins: ${String(error)}`));
  };

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const [lastAttempt] = await options.sql<{ started_at: Date; status: string }[]>`
        SELECT started_at, status FROM extraction_runs ORDER BY id DESC LIMIT 1`;
      if (lastAttempt?.status === "failed" && Date.now() - lastAttempt.started_at.getTime() < RETRY_AFTER_FAILURE_MS) return;

      const pending = await pendingStats(options.sql, options.config.CHAT_ID);
      const lastRun = await lastSuccessfulRunAt(options.sql);
      if (isPassDue(pending, lastRun, options.intervalHours)) {
        const result = await runExtractionPass(options);
        log(
          `[extract] ${result.messages} messages in ${result.calls} call(s): ${result.topics} topics, facts +${result.factsAdded} ↑${result.factsReinforced} ✎${result.factsUpdated}, projects +${result.projectsCreated} ~${result.projectsUpdated}`,
        );
      }

      if (await isConsolidationDue(options.sql)) {
        const cleaned = await runConsolidation(options.sql, options.anthropic, options.config.EXTRACTION_MODEL, options.config.MONTHLY_LLM_BUDGET_USD);
        log(`[consolidate] merged ${cleaned.factsMerged} facts, dropped ${cleaned.factsDropped}, merged ${cleaned.projectsMerged} projects, updated ${cleaned.projectsUpdated}`);
      }
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        await alertOnce(`⚠️ ${error.message}. Летопись и карточки на паузе до следующего месяца или пока не поднимешь MONTHLY_LLM_BUDGET_USD.`);
      } else {
        log(`[extract] failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        await alertOnce(`⚠️ Ошибка обработки сообщений: ${error instanceof Error ? error.message : String(error)}. Повторю через час.`);
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), options.checkEveryMs ?? 5 * 60_000);
  void tick();
  return () => clearInterval(timer);
}
