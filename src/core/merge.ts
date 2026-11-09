import type { Sql } from "./db.js";

/**
 * Folds a seeded card (a user row without a Telegram account) into a real account:
 * memberships, facts, project roles, votes and messages move over, the seed row disappears.
 */
export async function mergeSeedUser(sql: Sql, seedUserId: number, intoUserId: number, actorUserId: number): Promise<void> {
  await sql.begin(async (tx) => {
    const [seed] = await tx<{ tg_id: number | null; username: string | null }[]>`
      SELECT tg_id, username FROM users WHERE id = ${seedUserId} FOR UPDATE`;
    if (!seed) throw new Error("No such member");
    if (seed.tg_id !== null) throw new Error("This card is already linked to a Telegram account");

    await tx`
      INSERT INTO members (chat_id, user_id, tagline, tagline_manual, opted_out, first_seen_at, last_message_at, left_at)
      SELECT chat_id, ${intoUserId}, tagline, tagline_manual, opted_out, first_seen_at, last_message_at, left_at
      FROM members WHERE user_id = ${seedUserId}
      ON CONFLICT (chat_id, user_id) DO UPDATE SET
        tagline = CASE WHEN members.tagline IS NULL OR (NOT members.tagline_manual AND excluded.tagline_manual) THEN excluded.tagline ELSE members.tagline END,
        tagline_manual = members.tagline_manual OR excluded.tagline_manual,
        first_seen_at = least(members.first_seen_at, excluded.first_seen_at),
        last_message_at = greatest(members.last_message_at, excluded.last_message_at)`;
    await tx`
      UPDATE facts f SET user_id = ${intoUserId}
      WHERE f.user_id = ${seedUserId}
        AND NOT EXISTS (SELECT 1 FROM facts t WHERE t.chat_id = f.chat_id AND t.user_id = ${intoUserId} AND t.kind = f.kind AND t.value_norm = f.value_norm)`;
    await tx`DELETE FROM facts WHERE user_id = ${seedUserId}`;
    await tx`
      INSERT INTO rejected_facts (chat_id, user_id, kind, value_norm)
      SELECT chat_id, ${intoUserId}, kind, value_norm FROM rejected_facts WHERE user_id = ${seedUserId}
      ON CONFLICT DO NOTHING`;
    await tx`
      INSERT INTO project_members (project_id, user_id, role)
      SELECT project_id, ${intoUserId}, role FROM project_members WHERE user_id = ${seedUserId}
      ON CONFLICT (project_id, user_id) DO UPDATE SET role = coalesce(project_members.role, excluded.role)`;
    await tx`
      INSERT INTO votes (project_id, user_id, created_at)
      SELECT project_id, ${intoUserId}, created_at FROM votes WHERE user_id = ${seedUserId}
      ON CONFLICT DO NOTHING`;
    await tx`UPDATE messages SET user_id = ${intoUserId} WHERE user_id = ${seedUserId}`;
    await tx`UPDATE links SET first_user_id = ${intoUserId} WHERE first_user_id = ${seedUserId}`;
    await tx`UPDATE project_signals SET user_id = ${intoUserId} WHERE user_id = ${seedUserId}`;
    await tx`DELETE FROM users WHERE id = ${seedUserId}`;
    if (seed.username) {
      await tx`UPDATE users SET username = ${seed.username} WHERE id = ${intoUserId} AND username IS NULL`;
    }
    await tx`
      INSERT INTO change_log (entity, entity_id, op, before, source, actor_user_id)
      VALUES ('user', ${intoUserId}, 'merge_seed', ${tx.json({ seed_user_id: seedUserId })}, 'admin', ${actorUserId})`;
  });
}
