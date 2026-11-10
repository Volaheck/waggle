import type { Queryable, Sql } from "./db.js";
import { forgetNotes } from "./notes.js";

/** Telegram's own accounts that post for linked channels, anonymous admins and channel identities: never people. */
export const SERVICE_TG_IDS = [777000, 1087968824, 136817688];

/** A Telegram account. What the bot knows about the person lives per chat (see Member). */
export interface User {
  id: number;
  tg_id: number | null;
  username: string | null;
  display_name: string;
  is_admin: boolean;
  dm_started: boolean;
  current_chat_id: number | null;
  /** How the account came to own an imported card: null for its own, "owner" after /link, "name" or "username" when claimed automatically. */
  linked_by?: "owner" | "name" | "username" | null;
}

/** A person's presence in one chat: their card there is independent from other chats. */
export interface Member {
  chat_id: number;
  user_id: number;
  tagline: string | null;
  tagline_manual: boolean;
  opted_out: boolean;
  first_seen_at: Date | null;
  last_message_at: Date | null;
  left_at: Date | null;
}

/** A user as seen from one chat. */
export type Person = User & Member;

export interface TelegramIdentity {
  id: number;
  username?: string;
  first_name: string;
  last_name?: string;
}

export function fullName(identity: TelegramIdentity): string {
  return [identity.first_name, identity.last_name].filter(Boolean).join(" ").trim();
}

const CLAIM_BY_NAME = false;

const PERSON_COLUMNS = `u.id, u.tg_id, u.username, u.display_name, u.is_admin, u.dm_started, u.current_chat_id,
  m.chat_id, m.user_id, m.tagline, m.tagline_manual, m.opted_out, m.first_seen_at, m.last_message_at, m.left_at`;

/**
 * A seeded card (no account yet) the account may take over. By @username anywhere. By name only when the
 * match is unambiguous and the card holds nothing a look-alike account could misuse: the card has no
 * @username of its own, it is the only unlinked card with that name in the chat, it belongs to no other
 * chat and authors no project. Everything else waits for an owner's /link.
 */
async function claimableSeed(sql: Sql, username: string | null, name: string, chatId: number | undefined): Promise<{ seed: User; by: "name" | "username" } | undefined> {
  if (username) {
    const [byUsername] = await sql<User[]>`
      SELECT * FROM users WHERE tg_id IS NULL AND username IS NOT NULL AND lower(username) = lower(${username})`;
    if (byUsername) return { seed: byUsername, by: "username" };
  }
  // A display name proves nothing (anyone can copy one): a card that matches only by name waits for an owner's /link.
  if (chatId === undefined || !CLAIM_BY_NAME) return undefined;
  const byName = await sql<(User & { claimable: boolean })[]>`
    SELECT u.*,
           (u.username IS NULL
            AND NOT EXISTS (SELECT 1 FROM members other WHERE other.user_id = u.id AND other.chat_id <> ${chatId})
            AND NOT EXISTS (SELECT 1 FROM project_members pm WHERE pm.user_id = u.id)) AS claimable
    FROM users u
    WHERE u.tg_id IS NULL AND lower(u.display_name) = lower(${name})
      AND EXISTS (SELECT 1 FROM members m WHERE m.user_id = u.id AND m.chat_id = ${chatId})
    LIMIT 2`;
  const [only] = byName;
  return byName.length === 1 && only?.claimable ? { seed: only, by: "name" } : undefined;
}

/**
 * Finds the user for a Telegram account; a seeded card is linked when claimableSeed allows it.
 * Owner rights follow the configured owner list on every call, so removing an owner revokes them.
 * With a chat id the person also becomes (again) a member of that chat.
 */
export async function resolveUser(sql: Sql, identity: TelegramIdentity, adminTgIds: number[], chatId?: number): Promise<User> {
  return (await resolveAccount(sql, identity, adminTgIds, chatId)).user;
}

/**
 * resolveUser that also says whether the account has just appeared in the chat for the first time, as itself and not
 * as a card it took over, and whether it has just taken over an imported card by name or @username.
 */
export async function resolveAccount(
  sql: Sql,
  identity: TelegramIdentity,
  adminTgIds: number[],
  chatId?: number,
): Promise<{ user: User; joined: boolean; claimedBy: "name" | "username" | null }> {
  const name = fullName(identity) || identity.username || `user${identity.id}`;
  const username = identity.username ?? null;
  const isAdmin = adminTgIds.includes(identity.id);
  let user: User | undefined;
  let claimedBy: "name" | "username" | null = null;

  const [existing] = await sql<User[]>`SELECT * FROM users WHERE tg_id = ${identity.id}`;
  if (existing) {
    if (username && username.toLowerCase() !== existing.username?.toLowerCase()) {
      await sql`UPDATE users SET username = NULL WHERE lower(username) = lower(${username}) AND id <> ${existing.id}`;
    }
    [user] = await sql<User[]>`
      UPDATE users SET username = ${username}, display_name = ${name}, is_admin = ${isAdmin}
      WHERE id = ${existing.id}
      RETURNING *`;
  } else {
    const seeded = await claimableSeed(sql, username, name, chatId);
    if (seeded) {
      // Seed names come from someone's contact list; from now on the person's own Telegram name wins. A card claimed
      // this way is not edited from the chat until an owner confirms it with /link (src/bot/self-edits.ts).
      [user] = await sql<User[]>`
        UPDATE users SET tg_id = ${identity.id}, username = coalesce(${username}, username), display_name = ${name}, is_admin = ${isAdmin}, linked_by = ${seeded.by}
        WHERE id = ${seeded.seed.id}
        RETURNING *`;
      claimedBy = seeded.by;
    } else {
      if (username) {
        await sql`UPDATE users SET username = NULL WHERE lower(username) = lower(${username}) AND tg_id IS DISTINCT FROM ${identity.id}`;
      }
      [user] = await sql<User[]>`
        INSERT INTO users (tg_id, username, display_name, is_admin) VALUES (${identity.id}, ${username}, ${name}, ${isAdmin})
        RETURNING *`;
    }
  }
  if (!user) throw new Error("Could not resolve the Telegram user");
  const joined = chatId !== undefined && (await ensureMember(sql, chatId, user.id));
  return { user, joined, claimedBy };
}

/** Makes the person a member of the chat again; true when this is their first time there. */
export async function ensureMember(sql: Sql, chatId: number, userId: number): Promise<boolean> {
  const [row] = await sql<{ joined: boolean }[]>`
    INSERT INTO members (chat_id, user_id) VALUES (${chatId}, ${userId})
    ON CONFLICT (chat_id, user_id) DO UPDATE SET left_at = NULL
    RETURNING (xmax = 0) AS joined`;
  return row?.joined ?? false;
}

/** A Telegram account (not a card) that is a member of the chat, by its @username. */
export async function accountByUsername(sql: Sql, chatId: number, username: string): Promise<User | undefined> {
  const [user] = await sql<User[]>`
    SELECT u.* FROM users u JOIN members m ON m.user_id = u.id
    WHERE m.chat_id = ${chatId} AND u.tg_id IS NOT NULL AND u.tg_id <> ALL(${SERVICE_TG_IDS}::bigint[])
      AND lower(u.username) = lower(${username.replace(/^@/, "")})`;
  return user;
}

export async function getPerson(sql: Sql, chatId: number, userId: number): Promise<Person | undefined> {
  const [person] = await sql<Person[]>`
    SELECT ${sql.unsafe(PERSON_COLUMNS)} FROM users u JOIN members m ON m.user_id = u.id
    WHERE m.chat_id = ${chatId} AND u.id = ${userId}`;
  return person;
}

export async function peopleOfChat(sql: Sql, chatId: number, options: { includeLeft?: boolean } = {}): Promise<Person[]> {
  return sql<Person[]>`
    SELECT ${sql.unsafe(PERSON_COLUMNS)} FROM users u JOIN members m ON m.user_id = u.id
    WHERE m.chat_id = ${chatId} AND (${options.includeLeft ?? false} OR m.left_at IS NULL)
      AND (u.tg_id IS NULL OR u.tg_id <> ALL(${SERVICE_TG_IDS}::bigint[]))
    ORDER BY m.last_message_at DESC NULLS LAST, u.display_name`;
}

export async function findPersonByRef(sql: Sql, chatId: number, ref: string): Promise<Person | undefined> {
  const cleaned = ref.trim().replace(/^@/, "");
  if (!cleaned) return undefined;
  const [person] = await sql<Person[]>`
    SELECT ${sql.unsafe(PERSON_COLUMNS)} FROM users u JOIN members m ON m.user_id = u.id
    WHERE m.chat_id = ${chatId} AND (u.tg_id IS NULL OR u.tg_id <> ALL(${SERVICE_TG_IDS}::bigint[]))
      AND (lower(u.username) = lower(${cleaned}) OR lower(u.display_name) = lower(${cleaned}) OR lower(u.display_name) LIKE lower(${cleaned}) || ' %')
    ORDER BY lower(u.username) = lower(${cleaned}) DESC NULLS LAST, m.last_message_at DESC NULLS LAST
    LIMIT 1`;
  return person;
}

export async function getUser(sql: Sql, id: number): Promise<User | undefined> {
  const [user] = await sql<User[]>`SELECT * FROM users WHERE id = ${id}`;
  return user;
}

export async function getUserByTgId(sql: Sql, tgId: number): Promise<User | undefined> {
  const [user] = await sql<User[]>`SELECT * FROM users WHERE tg_id = ${tgId}`;
  return user;
}

async function applyOptOut(tx: Queryable, userId: number, optedOut: boolean, scope: number | null): Promise<void> {
  await tx`
    UPDATE members SET opted_out = ${optedOut}, tagline = CASE WHEN ${optedOut} THEN NULL ELSE tagline END,
           tagline_manual = CASE WHEN ${optedOut} THEN false ELSE tagline_manual END
    WHERE user_id = ${userId} AND (${scope}::bigint IS NULL OR chat_id = ${scope}::bigint)`;
  if (optedOut) {
    await tx`DELETE FROM facts WHERE user_id = ${userId} AND (${scope}::bigint IS NULL OR chat_id = ${scope}::bigint)`;
    await tx`DELETE FROM rejected_facts WHERE user_id = ${userId} AND (${scope}::bigint IS NULL OR chat_id = ${scope}::bigint)`;
    await tx`DELETE FROM aliases WHERE user_id = ${userId} AND (${scope}::bigint IS NULL OR chat_id = ${scope}::bigint)`;
    await tx`DELETE FROM memos WHERE user_id = ${userId} AND (${scope}::bigint IS NULL OR chat_id = ${scope}::bigint)`;
    await forgetNotes(tx, userId, scope);
    // Notes on how the person uses others' projects are shown on those project cards, so they go as well.
    await tx`
      DELETE FROM project_signals s USING projects p
      WHERE s.project_id = p.id AND s.user_id = ${userId} AND (${scope}::bigint IS NULL OR p.chat_id = ${scope}::bigint)`;
  }
  await tx`
    INSERT INTO change_log (entity, entity_id, op, after, source, actor_user_id)
    VALUES ('user', ${userId}, ${optedOut ? "opt_out" : "opt_in"}, ${tx.json({ opted_out: optedOut, chat_id: scope })}, 'user', ${userId})`;
}

/** Opting out removes the person's card in one chat — or, without a chat id, in every chat. */
export async function setOptOut(sql: Sql, userId: number, optedOut: boolean, chatId?: number): Promise<void> {
  await sql.begin(async (tx) => {
    await applyOptOut(tx, userId, optedOut, chatId ?? null);
    if (optedOut) await dropCardRequests(tx, userId, chatId ?? null);
  });
}

/** Opting out leaves nothing to confirm or undo, and no card values in the requests' records. */
async function dropCardRequests(tx: Queryable, userId: number, chatId: number | null): Promise<void> {
  await tx`
    UPDATE self_edits SET status = CASE WHEN status IN ('proposed', 'applied') THEN 'refused' ELSE status END, plan = NULL, applied = NULL
    WHERE user_id = ${userId} AND (${chatId}::bigint IS NULL OR chat_id = ${chatId}::bigint)`;
}

/**
 * /forgetme and "stop collecting" in one chat (or, without a chat id, everywhere). With `messages` the text of
 * the person's messages is blanked too, and so is the text of the bot's answers to them (an interjection's copy in
 * its log included).
 */
export async function forgetUser(sql: Sql, userId: number, options: { chatId?: number; messages: boolean }): Promise<void> {
  const scope = options.chatId ?? null;
  await sql.begin(async (tx) => {
    await applyOptOut(tx, userId, true, scope);
    await dropCardRequests(tx, userId, scope);
    if (!options.messages) return;
    await tx`
      UPDATE interjections said SET text = NULL
      FROM messages answer JOIN messages asked ON asked.chat_id = answer.chat_id AND asked.msg_id = answer.reply_to_msg_id
      WHERE said.chat_id = answer.chat_id AND said.msg_id = answer.msg_id AND answer.from_bot
        AND asked.user_id = ${userId} AND (${scope}::bigint IS NULL OR answer.chat_id = ${scope}::bigint)`;
    await tx`
      UPDATE messages answer SET text = '', extracted_at = now()
      FROM messages asked
      WHERE answer.from_bot AND asked.chat_id = answer.chat_id AND asked.msg_id = answer.reply_to_msg_id
        AND asked.user_id = ${userId} AND (${scope}::bigint IS NULL OR answer.chat_id = ${scope}::bigint)`;
    await tx`
      UPDATE messages SET text = '', extracted_at = now()
      WHERE user_id = ${userId} AND (${scope}::bigint IS NULL OR chat_id = ${scope}::bigint)`;
  });
}

export async function setTagline(sql: Sql, chatId: number, userId: number, tagline: string | null, actorUserId: number): Promise<void> {
  await sql`UPDATE members SET tagline = ${tagline}, tagline_manual = ${tagline !== null} WHERE chat_id = ${chatId} AND user_id = ${userId}`;
  await sql`
    INSERT INTO change_log (entity, entity_id, op, after, source, actor_user_id)
    VALUES ('user', ${userId}, 'set_tagline', ${sql.json({ tagline, chat_id: chatId })}, 'user', ${actorUserId})`;
}

export async function markLeft(sql: Sql, chatId: number, tgId: number): Promise<void> {
  await sql`
    UPDATE members SET left_at = now()
    WHERE chat_id = ${chatId} AND user_id = (SELECT id FROM users WHERE tg_id = ${tgId})`;
}
