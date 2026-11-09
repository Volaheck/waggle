import { moveAliases } from "./aliases.js";
import type { Chat, ChatStatus } from "./chats.js";
import type { Queryable, Sql } from "./db.js";
import { moveNotes } from "./notes.js";
import { freeSlug } from "./projects.js";

/**
 * A basic group that becomes a supergroup gets a new chat id, and Telegram numbers the supergroup's messages
 * from 1 again. The old messages move with the chat but keep their order below zero, so they never collide
 * with the supergroup's own ids, and every reference to them (sources, chronicle, extraction runs) moves the same way.
 * They get no t.me link, which basic-group messages never had.
 */
const OLD_ID_SHIFT = 2 ** 31;

export interface ChatMigration {
  /** False when the move was already done: Telegram announces it in both chats, in any order. */
  firstRun: boolean;
  /** The old chat's standing taken over by the new id; null when the old chat was unknown. */
  carried: ChatStatus | null;
  /** The new chat's row after the move. */
  chat: Chat | undefined;
  moved: { members: number; messages: number; facts: number; projects: number; topics: number };
}

const markerKey = (oldChatId: number) => `migrated_chat:${oldChatId}`;

const shiftOldId = (id: number) => (id > 0 ? id - OLD_ID_SHIFT : id);

const shiftedId = (tx: Queryable, column: string) =>
  tx`(CASE WHEN ${tx.unsafe(column)} > 0 THEN ${tx.unsafe(column)} - ${OLD_ID_SHIFT}::bigint ELSE ${tx.unsafe(column)} END)`;

const shiftedIds = (tx: Queryable, column: string) =>
  tx`(SELECT coalesce(array_agg(CASE WHEN id > 0 THEN id - ${OLD_ID_SHIFT}::bigint ELSE id END ORDER BY position), '{}'::bigint[])
      FROM unnest(${tx.unsafe(column)}) WITH ORDINALITY AS shifted (id, position))`;

async function chatRow(tx: Queryable, chatId: number): Promise<Chat | undefined> {
  const [chat] = await tx<Chat[]>`SELECT * FROM chats WHERE id = ${chatId}`;
  return chat;
}

/**
 * The new id takes over the old chat's approval (or rejection), unless an owner already decided about the new id.
 * After the move the old id is "left"; an owner who later approves it from an old request approves the new id.
 */
async function carryStanding(tx: Queryable, oldChatId: number, newChatId: number, alreadyMoved: boolean): Promise<ChatStatus | null> {
  const [old] = await tx<Chat[]>`SELECT * FROM chats WHERE id = ${oldChatId} FOR UPDATE`;
  if (!old) return null;
  // Only an approved chat stores anything, so an old chat that holds data was approved, even if its "left" came first.
  const holdsData =
    old.status === "left" &&
    !alreadyMoved &&
    (await tx`SELECT 1 FROM members WHERE chat_id = ${oldChatId} UNION ALL SELECT 1 FROM messages WHERE chat_id = ${oldChatId} LIMIT 1`).length > 0;
  const carried: ChatStatus | null = old.status === "left" ? (holdsData ? "approved" : null) : old.status;
  if (carried) {
    await tx`
      INSERT INTO chats (id, title, status, added_by, decided_by, decided_at, monthly_budget_usd, chronicle_paused_at, chronicle_pause_reason, chronicle_resumed_at, interjections)
      VALUES (${newChatId}, ${old.title}, ${carried}, ${old.added_by}, ${old.decided_by}, ${old.decided_at}, ${old.monthly_budget_usd},
              ${old.chronicle_paused_at}, ${old.chronicle_pause_reason}, ${old.chronicle_resumed_at}, ${old.interjections})
      ON CONFLICT (id) DO UPDATE SET
        status = CASE WHEN chats.status IN ('pending', 'left') THEN excluded.status ELSE chats.status END,
        decided_by = CASE WHEN chats.status IN ('pending', 'left') THEN excluded.decided_by ELSE chats.decided_by END,
        decided_at = CASE WHEN chats.status IN ('pending', 'left') THEN excluded.decided_at ELSE chats.decided_at END,
        title = coalesce(chats.title, excluded.title),
        added_by = coalesce(chats.added_by, excluded.added_by),
        monthly_budget_usd = coalesce(chats.monthly_budget_usd, excluded.monthly_budget_usd),
        -- A paused chronicler stays paused on the new id until an owner resumes it.
        chronicle_paused_at = coalesce(chats.chronicle_paused_at, excluded.chronicle_paused_at),
        chronicle_pause_reason = coalesce(chats.chronicle_pause_reason, excluded.chronicle_pause_reason),
        chronicle_resumed_at = greatest(chats.chronicle_resumed_at, excluded.chronicle_resumed_at),
        -- An owner who turned the bot's interjections off on either id keeps them off.
        interjections = chats.interjections AND excluded.interjections`;
  }
  await tx`UPDATE chats SET status = 'left' WHERE id = ${oldChatId}`;
  return carried;
}

/** Moves everything stored under the old id. Rows the new id already has are merged, never duplicated; a rerun moves nothing. */
async function moveChatData(tx: Queryable, from: number, to: number): Promise<ChatMigration["moved"]> {
  const members = await tx`
    INSERT INTO members (chat_id, user_id, tagline, tagline_manual, opted_out, first_seen_at, last_message_at, left_at)
    SELECT ${to}, user_id, tagline, tagline_manual, opted_out, first_seen_at, last_message_at, left_at FROM members WHERE chat_id = ${from}
    ON CONFLICT (chat_id, user_id) DO UPDATE SET
      tagline = CASE WHEN members.tagline IS NULL OR (NOT members.tagline_manual AND excluded.tagline_manual) THEN excluded.tagline ELSE members.tagline END,
      tagline_manual = members.tagline_manual OR excluded.tagline_manual,
      opted_out = members.opted_out OR excluded.opted_out,
      first_seen_at = least(members.first_seen_at, excluded.first_seen_at),
      last_message_at = greatest(members.last_message_at, excluded.last_message_at)`;
  await tx`DELETE FROM members WHERE chat_id = ${from}`;

  const messages = await tx`
    UPDATE messages m SET chat_id = ${to}, msg_id = ${shiftedId(tx, "m.msg_id")}, reply_to_msg_id = ${shiftedId(tx, "m.reply_to_msg_id")},
           thread_id = ${shiftedId(tx, "m.thread_id")}
    WHERE m.chat_id = ${from}
      AND NOT EXISTS (SELECT 1 FROM messages x WHERE x.chat_id = ${to} AND x.msg_id = ${shiftedId(tx, "m.msg_id")})`;
  await tx`DELETE FROM messages WHERE chat_id = ${from}`;

  await tx`
    UPDATE facts kept SET
      status = CASE WHEN 'hidden' IN (kept.status, moving.status) THEN 'hidden'
                    WHEN 'manual' IN (kept.status, moving.status) THEN 'manual' ELSE kept.status END,
      confidence = greatest(kept.confidence, moving.confidence),
      source_msg_ids = (SELECT coalesce(array_agg(DISTINCT id), '{}'::bigint[]) FROM unnest(kept.source_msg_ids || ${shiftedIds(tx, "moving.source_msg_ids")}) AS id)
    FROM facts moving
    WHERE moving.chat_id = ${from} AND kept.chat_id = ${to}
      AND kept.user_id = moving.user_id AND kept.kind = moving.kind AND kept.value_norm = moving.value_norm`;
  const facts = await tx`
    UPDATE facts f SET chat_id = ${to}, source_msg_ids = ${shiftedIds(tx, "f.source_msg_ids")}
    WHERE f.chat_id = ${from}
      AND NOT EXISTS (SELECT 1 FROM facts x WHERE x.chat_id = ${to} AND x.user_id = f.user_id AND x.kind = f.kind AND x.value_norm = f.value_norm)`;
  await tx`DELETE FROM facts WHERE chat_id = ${from}`;

  await tx`
    INSERT INTO rejected_facts (chat_id, user_id, kind, value_norm, created_at)
    SELECT ${to}, user_id, kind, value_norm, created_at FROM rejected_facts WHERE chat_id = ${from}
    ON CONFLICT DO NOTHING`;
  await tx`DELETE FROM rejected_facts WHERE chat_id = ${from}`;
  // What someone removed stays removed, and nothing stays about someone who opted out, whichever id it was noted under.
  await tx`
    DELETE FROM facts f USING rejected_facts r
    WHERE f.chat_id = ${to} AND r.chat_id = ${to} AND r.user_id = f.user_id AND r.kind = f.kind AND r.value_norm = f.value_norm
      AND f.status IN ('auto', 'deprecated')`;
  await tx`DELETE FROM facts f USING members m WHERE f.chat_id = ${to} AND m.chat_id = ${to} AND m.user_id = f.user_id AND m.opted_out`;
  await tx`DELETE FROM rejected_facts r USING members m WHERE r.chat_id = ${to} AND m.chat_id = ${to} AND m.user_id = r.user_id AND m.opted_out`;
  await tx`UPDATE members SET tagline = NULL, tagline_manual = false WHERE chat_id = ${to} AND opted_out AND tagline IS NOT NULL`;

  // Projects keep their ids, so a project's aliases only change chats; topics keep theirs too, so do the notes' links to them.
  await moveAliases(tx, from, to);
  await moveNotes(tx, from, to, (column) => shiftedIds(tx, column));

  // A project keeps its id (votes, authors and signals stay attached); a slug the new id already uses gets a suffix.
  const projects = await tx<{ id: number; slug: string }[]>`SELECT id, slug FROM projects WHERE chat_id = ${from} ORDER BY hidden, id`;
  for (const project of projects) {
    const slug = await freeSlug(tx, to, project.slug);
    await tx`
      UPDATE projects SET chat_id = ${to}, slug = ${slug},
             first_seen_msg_id = ${shiftedId(tx, "first_seen_msg_id")}, source_msg_ids = ${shiftedIds(tx, "source_msg_ids")}
      WHERE id = ${project.id}`;
    await tx`UPDATE project_signals SET source_msg_ids = ${shiftedIds(tx, "source_msg_ids")} WHERE project_id = ${project.id}`;
  }
  await tx`
    DELETE FROM project_signals s USING projects p, members m
    WHERE s.project_id = p.id AND p.chat_id = ${to} AND m.chat_id = ${to} AND m.user_id = s.user_id AND m.opted_out`;

  const topics = await tx`UPDATE chronicle SET chat_id = ${to}, msg_ids = ${shiftedIds(tx, "msg_ids")} WHERE chat_id = ${from}`;
  await tx`UPDATE themes SET chat_id = ${to} WHERE chat_id = ${from}`;
  await tx`
    UPDATE extraction_runs SET chat_id = ${to}, first_msg_id = ${shiftedId(tx, "first_msg_id")}, last_msg_id = ${shiftedId(tx, "last_msg_id")}
    WHERE chat_id = ${from}`;

  // The gaps and the daily cap of the bot's interjections go on counting under the new id.
  await tx`UPDATE interjections SET chat_id = ${to}, msg_id = ${shiftedId(tx, "msg_id")} WHERE chat_id = ${from}`;
  await tx`UPDATE llm_usage SET chat_id = ${to} WHERE chat_id = ${from}`;
  await tx`UPDATE users SET current_chat_id = ${to} WHERE current_chat_id = ${from}`;

  // Per-chat job state (last_consolidation:<chat id>, extraction_skipped:<chat id> and the like) follows the chat,
  // and message ids kept in it move like the messages. Otherwise the new id's own state wins.
  const suffix = `:${from}`;
  const states = await tx<{ key: string; value: Record<string, unknown> }[]>`
    SELECT key, value FROM app_state WHERE right(key, ${suffix.length}) = ${suffix} AND key <> ${markerKey(from)}`;
  for (const { key, value } of states) {
    const renamed = `${key.slice(0, -suffix.length)}:${to}`;
    const movedIds = Array.isArray(value.msg_ids) ? (value.msg_ids as number[]).map(shiftOldId) : undefined;
    const [kept] = await tx<{ value: Record<string, unknown> }[]>`SELECT value FROM app_state WHERE key = ${renamed} FOR UPDATE`;
    if (kept) {
      if (movedIds && Array.isArray(kept.value.msg_ids)) {
        const merged = [...new Set([...movedIds, ...(kept.value.msg_ids as number[])])];
        await tx`UPDATE app_state SET value = ${tx.json({ ...kept.value, msg_ids: merged })} WHERE key = ${renamed}`;
      }
      await tx`DELETE FROM app_state WHERE key = ${key}`;
      continue;
    }
    if (movedIds) await tx`UPDATE app_state SET value = ${tx.json({ ...value, msg_ids: movedIds })} WHERE key = ${key}`;
    await tx`UPDATE app_state SET key = ${renamed} WHERE key = ${key}`;
  }

  return { members: members.count, messages: messages.count, facts: facts.count, projects: projects.length, topics: topics.count };
}

/**
 * Follows a group → supergroup upgrade: the chat's approval and everything stored about it move to the new id,
 * in one transaction. Safe to call any number of times and from either chat's service message.
 */
export async function migrateChat(sql: Sql, oldChatId: number, newChatId: number): Promise<ChatMigration> {
  const nothing = { members: 0, messages: 0, facts: 0, projects: 0, topics: 0 };
  if (oldChatId === newChatId) return { firstRun: false, carried: null, chat: await chatRow(sql, newChatId), moved: nothing };
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('waggle:chat-migration'), hashtext(${String(oldChatId)}))`;
    const [marker] = await tx<{ value: { to: number } }[]>`SELECT value FROM app_state WHERE key = ${markerKey(oldChatId)}`;
    if (marker && marker.value.to !== newChatId) return { firstRun: false, carried: null, chat: await chatRow(tx, newChatId), moved: nothing };
    const carried = await carryStanding(tx, oldChatId, newChatId, Boolean(marker));
    if (!marker) {
      await tx`
        INSERT INTO app_state (key, value) VALUES (${markerKey(oldChatId)}, ${tx.json({ to: newChatId, carried, at: new Date().toISOString() })})
        ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`;
    }
    const moved = await moveChatData(tx, oldChatId, newChatId);
    return { firstRun: !marker, carried, chat: await chatRow(tx, newChatId), moved };
  });
}
