import Anthropic from "@anthropic-ai/sdk";
import type { Sql } from "./db.js";

/** USD per million tokens, Claude API first-party prices (2026-10). */
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function estimateCostUsd(model: string, usage: UsageLike): number {
  const price = PRICES[model];
  if (!price) return 0;
  const perToken = (rate: number, tokens: number) => (rate * tokens) / 1_000_000;
  return (
    perToken(price.input, usage.input_tokens) +
    perToken(price.output, usage.output_tokens) +
    perToken(price.cacheRead, usage.cache_read_input_tokens ?? 0) +
    perToken(price.cacheWrite, usage.cache_creation_input_tokens ?? 0)
  );
}

export async function recordUsage(sql: Sql, purpose: string, model: string, usage: UsageLike, chatId: number | null = null): Promise<void> {
  await sql`
    INSERT INTO llm_usage (chat_id, purpose, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
    VALUES (${chatId}, ${purpose}, ${model}, ${usage.input_tokens}, ${usage.output_tokens},
            ${usage.cache_read_input_tokens ?? 0}, ${usage.cache_creation_input_tokens ?? 0}, ${estimateCostUsd(model, usage)})`;
}

export async function monthSpendUsd(sql: Sql, chatId?: number): Promise<number> {
  const scope = chatId ?? null;
  const [row] = await sql<{ total: string | null }[]>`
    SELECT sum(cost_usd)::text AS total FROM llm_usage
    WHERE at >= date_trunc('month', now()) AND (${scope}::bigint IS NULL OR chat_id = ${scope}::bigint)`;
  return Number(row?.total ?? 0);
}

export class BudgetExceededError extends Error {
  constructor(
    spent: number,
    limit: number,
    readonly chatId?: number,
  ) {
    super(`${chatId === undefined ? "Общий месячный бюджет" : "Месячный лимит этого чата"} на нейронку исчерпан: $${spent.toFixed(2)} из $${limit.toFixed(2)}`);
  }
}

/** Checks the bot-wide monthly cap and, for a chat, that chat's own cap. */
export async function assertBudget(sql: Sql, limitUsd: number, chat?: { id: number; limitUsd: number }): Promise<void> {
  const spent = await monthSpendUsd(sql);
  if (spent >= limitUsd) throw new BudgetExceededError(spent, limitUsd);
  if (chat) {
    const chatSpent = await monthSpendUsd(sql, chat.id);
    if (chatSpent >= chat.limitUsd) throw new BudgetExceededError(chatSpent, chat.limitUsd, chat.id);
  }
}

export function createAnthropic(apiKey?: string): Anthropic {
  return apiKey ? new Anthropic({ apiKey }) : new Anthropic();
}

export function textOf(content: Anthropic.Beta.BetaContentBlock[] | Anthropic.ContentBlock[]): string {
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
}
