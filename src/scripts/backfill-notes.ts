import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { approvedChats } from "../core/chats.js";
import { loadConfig, type Config } from "../core/config.js";
import { createSql, type Sql } from "../core/db.js";
import { assertBudget, BudgetExceededError, chatEndUserId, createAnthropic, recordUsage } from "../core/llm.js";
import type { StoredMessage } from "../core/messages.js";
import { consentObjectionsSince } from "../core/notes.js";
import { batchDataFor, MESSAGE_COLUMNS, skippedMessageIds } from "../worker/batch.js";
import { applyNotesResult, buildNotesPrompt, callNotesExtractor } from "../worker/notes-extract.js";
import { chatBudgetUsd } from "../worker/scheduler.js";

/**
 * Private notes and aliases for messages the chronicler went through before it kept notes: the notes call
 * (notes-extract.ts) runs over them, and nothing else — the chronicle, the cards and the messages stay as they are.
 * Messages the model refused before are never sent again, nor is anything from a chat whose chronicler is paused.
 * Spending is recorded as "backfill" and counts towards the usual caps.
 */

export const BACKFILL_PURPOSE = "backfill";

/** Set once a chat's messages were gone through, so running the script again leaves that chat alone. */
const doneKey = (chatId: number) => `notes_backfill:${chatId}`;

/** About a day of a busy chat, so the notes of a whole week need not fit one answer; one cut off or unusable is halved, down to MIN_SLICE. */
const SLICE_MESSAGES = 400;
const MIN_SLICE = 25;

export interface BackfillOptions {
  sql: Sql;
  anthropic: Anthropic;
  config: Pick<Config, "EXTRACTION_MODEL" | "MONTHLY_LLM_BUDGET_USD" | "CHAT_MONTHLY_BUDGET_USD"> & Partial<Pick<Config, "ADMIN_TG_IDS" | "DISPLAY_TIMEZONE" | "BOT_TOKEN">>;
  /** How many days of messages to go back: their texts are kept no longer anyway. */
  days: number;
  /** Only messages the chronicler processed before this moment, with a prompt that knew no notes. */
  processedBefore: Date;
  /** Calls the model (and records what it cost) but stores nothing: the result says what would have been stored. */
  dryRun: boolean;
  /** Chats a backfill already went through, too. */
  again?: boolean;
  chatIds?: number[];
  log?: (line: string) => void;
}

export interface BackfillChat {
  chatId: number;
  title: string;
  messages: number;
  calls: number;
  failedCalls: number;
  /** Messages of slices that failed for good: a refusal, a used-up budget, or a slice too small to halve. */
  skippedMessages: number;
  notes: number;
  aliases: number;
  /** What was stored (or, in a dry run, would have been), one line each. */
  stored: string[];
  /** Who objected to being recorded: the owners should hear about it. */
  objectors: string[];
}

class DryRun extends Error {}

export async function backfillNotes(options: BackfillOptions): Promise<BackfillChat[]> {
  const { sql, config } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const results: BackfillChat[] = [];
  for (const chat of await approvedChats(sql)) {
    if (options.chatIds && !options.chatIds.includes(chat.id)) continue;
    const title = chat.title ?? String(chat.id);
    if (chat.chronicle_paused_at) {
      log(`[backfill] ${title}: the chronicler is paused there, skipped`);
      continue;
    }
    if (!options.again && (await sql`SELECT 1 FROM app_state WHERE key = ${doneKey(chat.id)}`).length > 0) {
      log(`[backfill] ${title}: done before, skipped (--again repeats it)`);
      continue;
    }
    const skipped = await skippedMessageIds(sql, chat.id);
    const messages = await sql<StoredMessage[]>`
      SELECT ${sql.unsafe(MESSAGE_COLUMNS)} FROM messages
      WHERE chat_id = ${chat.id} AND extracted_at IS NOT NULL AND extracted_at < ${options.processedBefore}
        AND sent_at > now() - make_interval(days => ${options.days}) AND btrim(text) <> '' AND msg_id <> ALL(${skipped}::bigint[])
      ORDER BY msg_id`;
    if (!messages.some((message) => !message.from_bot && !message.is_forward && message.text.trim().length >= 3)) continue;

    const result: BackfillChat = { chatId: chat.id, title, messages: messages.length, calls: 0, failedCalls: 0, skippedMessages: 0, notes: 0, aliases: 0, stored: [], objectors: [] };
    results.push(result);
    const startedAt = (await sql<{ at: Date }[]>`SELECT now() AS at`)[0]!.at;
    const slices: StoredMessage[][] = [];
    for (let start = 0; start < messages.length; start += SLICE_MESSAGES) slices.push(messages.slice(start, start + SLICE_MESSAGES));
    while (slices.length) {
      const slice = slices.shift()!;
      try {
        await assertBudget(sql, config.MONTHLY_LLM_BUDGET_USD, { id: chat.id, limitUsd: chatBudgetUsd(chat, config.CHAT_MONTHLY_BUDGET_USD) });
      } catch (error) {
        if (!(error instanceof BudgetExceededError)) throw error;
        log(`[backfill] ${title}: ${error.message}; stopped there`);
        result.skippedMessages += [slice, ...slices].reduce((sum, rest) => sum + rest.length, 0);
        break;
      }
      const data = await batchDataFor(sql, chat.id, slice);
      data.ownerTgIds = config.ADMIN_TG_IDS ?? [];
      data.timezone = config.DISPLAY_TIMEZONE;
      const outcome = await callNotesExtractor(
        options.anthropic,
        config.EXTRACTION_MODEL,
        buildNotesPrompt(data, []),
        (usage) => recordUsage(sql, BACKFILL_PURPOSE, config.EXTRACTION_MODEL, usage, chat.id),
        undefined,
        config.BOT_TOKEN ? chatEndUserId(config.BOT_TOKEN, chat.id) : undefined,
      );
      result.calls += 1;
      if (!outcome.ok) {
        result.failedCalls += 1;
        // A refused slice is never sent again: repeated refusals can count against the Anthropic account.
        if (outcome.failure !== "refusal" && slice.length >= 2 * MIN_SLICE) {
          const half = Math.ceil(slice.length / 2);
          slices.unshift(slice.slice(0, half), slice.slice(half));
          continue;
        }
        result.skippedMessages += slice.length;
        log(`[backfill] ${title}: ${slice.length} messages from ${slice[0]!.msg_id} skipped: ${outcome.message}`);
        continue;
      }
      // In a dry run the notes are written and read back inside a transaction that is then rolled back.
      await sql
        .begin(async (tx) => {
          const applied = await applyNotesResult(tx, data, outcome.data, []);
          result.notes += applied.notes;
          result.aliases += applied.aliases;
          const notes = await tx<{ kind: string; about: string | null; value: string; status: string | null; due_at: Date | null; name: string | null }[]>`
            SELECT n.kind, n.about, n.value, n.status, n.due_at, u.display_name AS name
            FROM notes n LEFT JOIN users u ON u.id = n.user_id
            WHERE n.chat_id = ${chat.id} AND n.updated_at = now() AND n.superseded_by IS NULL
            ORDER BY n.id`;
          const aliases = await tx<{ alias: string; name: string }[]>`
            SELECT a.alias, u.display_name AS name FROM aliases a JOIN users u ON u.id = a.user_id
            WHERE a.chat_id = ${chat.id} AND a.created_at = now()
            ORDER BY a.id`;
          for (const note of notes) {
            const state = [note.status, note.due_at ? `due ${note.due_at.toISOString().slice(0, 10)}` : ""].filter(Boolean).join(", ");
            result.stored.push(`${note.kind} · ${note.name ?? "the chat"}${state ? ` · ${state}` : ""}${note.about ? ` · ${note.about}` : ""}: ${note.value}`);
          }
          for (const alias of aliases) result.stored.push(`alias · ${alias.name}: ${alias.alias}`);
          for (const person of await consentObjectionsSince(tx, chat.id, startedAt)) {
            const who = `${person.display_name}${person.username ? ` (@${person.username})` : ""}`;
            if (!result.objectors.includes(who)) result.objectors.push(who);
          }
          if (options.dryRun) throw new DryRun();
        })
        .catch((error: unknown) => {
          if (!(error instanceof DryRun)) throw error;
        });
    }
    if (!options.dryRun && result.skippedMessages === 0) {
      await sql`
        INSERT INTO app_state (key, value) VALUES (${doneKey(chat.id)}, ${sql.json({ at: new Date().toISOString(), messages: result.messages, notes: result.notes, aliases: result.aliases })})
        ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`;
    }
  }
  return results;
}

const USAGE = `Usage: node dist/scripts/backfill-notes.js [--dry-run] [--days 7] [--chat <chat id>] [--again]
  --dry-run  call the model and print what would be stored, store nothing (the calls are still paid for and recorded)
  --days     how many days of messages to go through (default 7)
  --chat     only this chat
  --again    also chats a backfill already went through`;

const isMain = process.argv[1] && path.resolve(process.argv[1]).includes(`scripts${path.sep}backfill-notes`);
if (isMain) {
  const args = process.argv.slice(2);
  const valueOf = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  if (args.includes("--help")) {
    console.log(USAGE);
    process.exit(0);
  }
  const days = Number(valueOf("--days") ?? 7);
  const chat = valueOf("--chat");
  if (!Number.isInteger(days) || days < 1 || (chat !== undefined && !/^-?\d+$/.test(chat))) {
    console.error(USAGE);
    process.exit(1);
  }
  const config = loadConfig();
  if (!config.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
  const sql = createSql(config.DATABASE_URL);
  // Messages processed once the bot ran with this migration already got their notes from the chronicler itself.
  const [migration] = await sql<{ applied_at: Date }[]>`SELECT applied_at FROM schema_migrations WHERE name = '003_memory.sql'`;
  if (!migration) throw new Error("Migration 003_memory.sql is not applied yet: start the bot (or npm run migrate) first");
  const dryRun = args.includes("--dry-run");
  const results = await backfillNotes({
    sql,
    anthropic: createAnthropic(config.ANTHROPIC_API_KEY),
    config,
    days,
    processedBefore: migration.applied_at,
    dryRun,
    again: args.includes("--again"),
    chatIds: chat === undefined ? undefined : [Number(chat)],
  });
  for (const result of results) {
    console.log(
      `\n${result.title} (${result.chatId}): ${result.messages} messages, ${result.calls} call(s)${result.failedCalls ? `, ${result.failedCalls} failed` : ""}${result.skippedMessages ? `, ${result.skippedMessages} messages skipped` : ""}; ` +
        `${dryRun ? "would store" : "stored"} ${result.notes} note(s) and ${result.aliases} alias(es)`,
    );
    for (const line of result.stored) console.log(`  ${line}`);
    if (result.objectors.length) console.log(`  ⚠️ objected to being recorded: ${result.objectors.join(", ")} — tell the owners`);
  }
  if (results.length === 0) console.log("Nothing to go through.");
  await sql.end();
}
