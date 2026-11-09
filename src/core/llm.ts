import { createHmac } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Queryable, Sql } from "./db.js";

interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface ModelPrice extends Rates {
  /** Some models switch to another rate card once the prompt is longer than `overTokens`. */
  longPrompt?: Rates & { overTokens: number };
}

/** USD per million tokens, Claude API first-party prices (2026-10). Cache writes are the 5-minute ones. */
const PRICES: Record<string, ModelPrice> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "claude-mythos-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    longPrompt: { overTokens: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
  },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

/** A model missing from the table is charged at the highest known rates, so the budget caps keep working. */
const FALLBACK_PRICE: ModelPrice = {
  input: Math.max(...Object.values(PRICES).map((price) => price.input)),
  output: Math.max(...Object.values(PRICES).map((price) => price.output)),
  cacheRead: Math.max(...Object.values(PRICES).map((price) => price.cacheRead)),
  cacheWrite: Math.max(...Object.values(PRICES).map((price) => price.cacheWrite)),
};

/** «anthropic.claude-sonnet-5-5», «claude-sonnet-5-5@20261001», «claude-sonnet-5-5-20261001» → «claude-sonnet-5-5». */
export function canonicalModelId(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/^(?:[a-z]+\.)?anthropic\./, "")
    .replace(/\[[^\]]*\]$/, "")
    .replace(/@.*$/, "")
    .replace(/-v\d+(?::\d+)?$/, "")
    .replace(/-\d{8}$/, "");
}

export function isPricedModel(model: string): boolean {
  return canonicalModelId(model) in PRICES;
}

const warnedModels = new Set<string>();

function priceFor(model: string): ModelPrice {
  const price = PRICES[canonicalModelId(model)];
  if (price) return price;
  if (!warnedModels.has(model)) {
    warnedModels.add(model);
    console.warn(`[llm] no price known for model “${model}”: its calls are counted at the highest known rates`);
  }
  return FALLBACK_PRICE;
}

export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function estimateCostUsd(model: string, usage: UsageLike): number {
  const price = priceFor(model);
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const promptTokens = usage.input_tokens + cacheRead + cacheWrite;
  const rates = price.longPrompt && promptTokens > price.longPrompt.overTokens ? price.longPrompt : price;
  const perToken = (rate: number, tokens: number) => (rate * tokens) / 1_000_000;
  return perToken(rates.input, usage.input_tokens) + perToken(rates.output, usage.output_tokens) + perToken(rates.cacheRead, cacheRead) + perToken(rates.cacheWrite, cacheWrite);
}

export async function recordUsage(sql: Queryable, purpose: string, model: string, usage: UsageLike, chatId: number | null = null): Promise<void> {
  await sql`
    INSERT INTO llm_usage (chat_id, purpose, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
    VALUES (${chatId}, ${purpose}, ${model}, ${usage.input_tokens}, ${usage.output_tokens},
            ${usage.cache_read_input_tokens ?? 0}, ${usage.cache_creation_input_tokens ?? 0}, ${estimateCostUsd(model, usage)})`;
}

/**
 * The stronger answering model's usage. It has a cap of its own (REPLY_PREMIUM_MONTHLY_BUDGET_USD) and counts towards
 * no other, so it can never silence a chat or stop its chronicler.
 */
export const PREMIUM_REPLY_PURPOSE = "reply_premium";

/** This month's spending on everything but the stronger model's answers, across all chats or in one. */
export async function monthSpendUsd(sql: Sql, chatId?: number): Promise<number> {
  const scope = chatId ?? null;
  const [row] = await sql<{ total: string | null }[]>`
    SELECT sum(cost_usd)::text AS total FROM llm_usage
    WHERE at >= date_trunc('month', now()) AND purpose <> ${PREMIUM_REPLY_PURPOSE} AND (${scope}::bigint IS NULL OR chat_id = ${scope}::bigint)`;
  return Number(row?.total ?? 0);
}

export class BudgetExceededError extends Error {
  constructor(
    spent: number,
    limit: number,
    readonly chatId?: number,
  ) {
    super(`${chatId === undefined ? "The overall monthly AI budget" : "This chat's monthly AI limit"} is used up: $${spent.toFixed(2)} of $${limit.toFixed(2)}`);
  }
}

/** Checks the bot-wide monthly cap and, for a chat, that chat's own cap (both without the stronger model's answers). */
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

const STRING_FORMATS = new Set(["date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"]);

/** Keeps what structured outputs enforce (enum included) and drops the constraints the API rejects, such as minimum and maximum. */
function strictSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictSchema);
  if (!node || typeof node !== "object") return node;
  const source = node as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of ["type", "description", "enum", "const", "required", "$ref"]) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  if (typeof source.format === "string" && STRING_FORMATS.has(source.format)) result.format = source.format;
  if (source.items !== undefined) result.items = strictSchema(source.items);
  if (Array.isArray(source.anyOf ?? source.oneOf)) result.anyOf = strictSchema(source.anyOf ?? source.oneOf);
  if (Array.isArray(source.allOf)) result.allOf = strictSchema(source.allOf);
  for (const key of ["properties", "$defs"]) {
    const children = source[key];
    if (children && typeof children === "object") {
      result[key] = Object.fromEntries(Object.entries(children).map(([name, child]) => [name, strictSchema(child)]));
    }
  }
  if (result.type === "object") result.additionalProperties = false;
  return result;
}

/**
 * The output format for a zod schema. Unlike the SDK's zodOutputFormat it keeps `enum` (the SDK
 * moves it into the description, so the model is not held to the list) and has no parse hook:
 * a truncated or refused answer then reaches our own checks instead of failing inside the SDK.
 */
export function structuredOutputFormat(schema: z.ZodType): Anthropic.JSONOutputFormat {
  return { type: "json_schema", schema: strictSchema(z.toJSONSchema(schema)) as Record<string, unknown> };
}

export type StructuredFailure = "refusal" | "max_tokens" | "invalid_output";

export type StructuredOutcome<T> = { ok: true; data: T } | { ok: false; failure: StructuredFailure; message: string };

export interface StructuredRequest<T> {
  model: string;
  maxTokens: number;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  /** "low", the chronicler's, when not given. */
  effort?: "low" | "medium" | "high";
  /** Called with the usage of every billed response, before anything is checked: failed calls cost money too. */
  onUsage: (usage: UsageLike) => Promise<void>;
  /** Cancels the call (the bot is stopping); the usage it reached is still recorded. */
  signal?: AbortSignal;
  /** Who the request is made for, as an opaque id (see chatEndUserId): Anthropic uses it to tell one end user's abuse from another's. */
  endUserId?: string;
}

/**
 * The chat as Anthropic's end user, sent as metadata.user_id: an HMAC of the chat id, so requests from one chat can be
 * told apart without revealing which chat it is (a plain hash of a chat id could be reversed by trying them all).
 */
export function chatEndUserId(secret: string, chatId: number): string {
  return createHmac("sha256", secret).update(`waggle-chat:${chatId}`).digest("hex").slice(0, 32);
}

/** A member who asks the bot something, as Anthropic's end user: an HMAC of the chat and the member's Telegram id. */
export function memberEndUserId(secret: string, chatId: number, telegramId: number): string {
  return createHmac("sha256", secret).update(`waggle-member:${chatId}:${telegramId}`).digest("hex").slice(0, 32);
}

/**
 * One structured-output call. Transport errors are thrown (after the usage of a broken stream is
 * recorded); a refusal, a cut-off answer or an answer that does not fit the schema comes back as a
 * failure, so the caller decides whether to retry with less input.
 */
export async function callStructured<T>(anthropic: Anthropic, request: StructuredRequest<T>): Promise<StructuredOutcome<T>> {
  const stream = anthropic.messages.stream(
    {
      model: request.model,
      max_tokens: request.maxTokens,
      output_config: { effort: request.effort ?? "low", format: structuredOutputFormat(request.schema) },
      // No prompt caching: passes run hours apart, far beyond the cache TTL, so a cache write would only cost extra.
      system: request.system,
      messages: [{ role: "user", content: request.prompt }],
      ...(request.endUserId ? { metadata: { user_id: request.endUserId } } : {}),
    },
    { signal: request.signal },
  );
  let response: Anthropic.Message;
  try {
    response = await stream.finalMessage();
  } catch (error) {
    const partial = stream.currentMessage?.usage;
    if (partial) await request.onUsage(partial);
    throw error;
  }
  await request.onUsage(response.usage);
  if (response.stop_reason === "refusal") {
    return { ok: false, failure: "refusal", message: `the model refused (${response.stop_details?.category ?? "no category"})` };
  }
  if (response.stop_reason === "max_tokens") return { ok: false, failure: "max_tokens", message: "the answer did not fit into max_tokens" };
  const text = response.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { ok: false, failure: "invalid_output", message: `the answer is not valid JSON (${error instanceof Error ? error.message : String(error)})` };
  }
  const parsed = request.schema.safeParse(json);
  if (!parsed.success) return { ok: false, failure: "invalid_output", message: `the answer does not match the schema: ${parsed.error.message}` };
  return { ok: true, data: parsed.data };
}
