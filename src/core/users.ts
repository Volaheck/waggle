import type { Sql } from "./db.js";

export interface User {
  id: number;
  tg_id: number | null;
  username: string | null;
  display_name: string;
  tagline: string | null;
  tagline_manual: boolean;
  is_admin: boolean;
  opted_out: boolean;
  dm_started: boolean;
  first_seen_at: Date | null;
  last_message_at: Date | null;
  left_at: Date | null;
}

export interface TelegramIdentity {
  id: number;
  username?: string;
  first_name: string;
  last_name?: string;
}

export function fullName(identity: TelegramIdentity): string {
  return [identity.first_name, identity.last_name].filter(Boolean).join(" ").trim();
}

/**
 * Finds the user for a Telegram account, linking a seeded (tg_id-less) user by
 * username or exact display name the first time that account shows up.
 */
export async function resolveUser(sql: Sql, identity: TelegramIdentity, adminTgIds: number[]): Promise<User> {
  const name = fullName(identity) || identity.username || `user${identity.id}`;
  const username = identity.username ?? null;
  const isAdmin = adminTgIds.includes(identity.id);

  const [existing] = await sql<User[]>`SELECT * FROM users WHERE tg_id = ${identity.id}`;
  if (existing) {
    if (username && username.toLowerCase() !== existing.username?.toLowerCase()) {
      await sql`UPDATE users SET username = NULL WHERE lower(username) = lower(${username}) AND id <> ${existing.id}`;
    }
    const [updated] = await sql<User[]>`
      UPDATE users
      SET username = ${username}, display_name = ${name}, is_admin = is_admin OR ${isAdmin}, left_at = NULL
      WHERE id = ${existing.id}
      RETURNING *`;
    return updated!;
  }

  const [seeded] = await sql<User[]>`
    SELECT * FROM users
    WHERE tg_id IS NULL
      AND ((${username}::text IS NOT NULL AND lower(username) = lower(${username}::text)) OR lower(display_name) = lower(${name}))
    ORDER BY (lower(username) = lower(${username}::text)) DESC NULLS LAST
    LIMIT 1`;
  if (seeded) {
    // The seed carries names from someone's contact list; from now on the person's own Telegram name wins.
    const [linked] = await sql<User[]>`
      UPDATE users
      SET tg_id = ${identity.id}, username = coalesce(${username}, username), display_name = ${name},
          is_admin = is_admin OR ${isAdmin}, left_at = NULL
      WHERE id = ${seeded.id}
      RETURNING *`;
    return linked!;
  }

  if (username) {
    await sql`UPDATE users SET username = NULL WHERE lower(username) = lower(${username}) AND tg_id IS DISTINCT FROM ${identity.id}`;
  }
  const [created] = await sql<User[]>`
    INSERT INTO users (tg_id, username, display_name, is_admin)
    VALUES (${identity.id}, ${username}, ${name}, ${isAdmin})
    RETURNING *`;
  return created!;
}

export async function findUserByRef(sql: Sql, ref: string): Promise<User | undefined> {
  const cleaned = ref.trim().replace(/^@/, "");
  if (!cleaned) return undefined;
  const [byUsername] = await sql<User[]>`SELECT * FROM users WHERE lower(username) = lower(${cleaned})`;
  if (byUsername) return byUsername;
  const [byName] = await sql<User[]>`
    SELECT * FROM users
    WHERE lower(display_name) = lower(${cleaned}) OR lower(display_name) LIKE lower(${cleaned}) || ' %'
    ORDER BY last_message_at DESC NULLS LAST
    LIMIT 1`;
  return byName;
}

export async function getUser(sql: Sql, id: number): Promise<User | undefined> {
  const [user] = await sql<User[]>`SELECT * FROM users WHERE id = ${id}`;
  return user;
}

export async function getUserByTgId(sql: Sql, tgId: number): Promise<User | undefined> {
  const [user] = await sql<User[]>`SELECT * FROM users WHERE tg_id = ${tgId}`;
  return user;
}

export async function setOptOut(sql: Sql, userId: number, optedOut: boolean): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`UPDATE users SET opted_out = ${optedOut}, tagline = CASE WHEN ${optedOut} THEN NULL ELSE tagline END WHERE id = ${userId}`;
    if (optedOut) {
      await tx`DELETE FROM facts WHERE user_id = ${userId}`;
      await tx`DELETE FROM rejected_facts WHERE user_id = ${userId}`;
    }
    await tx`
      INSERT INTO change_log (entity, entity_id, op, after, source, actor_user_id)
      VALUES ('user', ${userId}, ${optedOut ? "opt_out" : "opt_in"}, ${tx.json({ opted_out: optedOut })}, 'user', ${userId})`;
  });
}

export async function setTagline(sql: Sql, userId: number, tagline: string | null, actorUserId: number): Promise<void> {
  await sql`UPDATE users SET tagline = ${tagline}, tagline_manual = ${tagline !== null} WHERE id = ${userId}`;
  await sql`
    INSERT INTO change_log (entity, entity_id, op, after, source, actor_user_id)
    VALUES ('user', ${userId}, 'set_tagline', ${sql.json({ tagline })}, 'user', ${actorUserId})`;
}

export async function markLeft(sql: Sql, tgId: number): Promise<void> {
  await sql`UPDATE users SET left_at = now() WHERE tg_id = ${tgId}`;
}
