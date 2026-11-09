import type { Sql } from "./db.js";

/**
 * Folds a seeded account (no tg_id) into a real Telegram account: facts,
 * project memberships and votes move over, the seed row disappears.
 */
export async function mergeSeedUser(sql: Sql, seedUserId: number, intoUserId: number, actorUserId: number): Promise<void> {
  await sql.begin(async (tx) => {
    const [seed] = await tx<{ tg_id: number | null; tagline: string | null; tagline_manual: boolean; username: string | null }[]>`
      SELECT tg_id, tagline, tagline_manual, username FROM users WHERE id = ${seedUserId} FOR UPDATE`;
    if (!seed) throw new Error("No such member");
    if (seed.tg_id !== null) throw new Error("This card is already linked to a Telegram account");

    await tx`
      UPDATE facts f SET user_id = ${intoUserId}
      WHERE f.user_id = ${seedUserId}
        AND NOT EXISTS (SELECT 1 FROM facts t WHERE t.user_id = ${intoUserId} AND t.kind = f.kind AND t.value_norm = f.value_norm)`;
    await tx`DELETE FROM facts WHERE user_id = ${seedUserId}`;
    await tx`
      INSERT INTO rejected_facts (user_id, kind, value_norm)
      SELECT ${intoUserId}, kind, value_norm FROM rejected_facts WHERE user_id = ${seedUserId}
      ON CONFLICT DO NOTHING`;
    await tx`
      INSERT INTO project_members (project_id, user_id)
      SELECT project_id, ${intoUserId} FROM project_members WHERE user_id = ${seedUserId}
      ON CONFLICT DO NOTHING`;
    await tx`
      INSERT INTO votes (project_id, user_id, created_at)
      SELECT project_id, ${intoUserId}, created_at FROM votes WHERE user_id = ${seedUserId}
      ON CONFLICT DO NOTHING`;
    await tx`UPDATE messages SET user_id = ${intoUserId} WHERE user_id = ${seedUserId}`;
    await tx`UPDATE links SET first_user_id = ${intoUserId} WHERE first_user_id = ${seedUserId}`;
    await tx`
      UPDATE users SET
        tagline = CASE WHEN tagline IS NULL OR (NOT tagline_manual AND ${seed.tagline_manual}) THEN ${seed.tagline} ELSE tagline END,
        tagline_manual = tagline_manual OR ${seed.tagline_manual}
      WHERE id = ${intoUserId}`;
    await tx`DELETE FROM users WHERE id = ${seedUserId}`;
    if (seed.username) {
      await tx`UPDATE users SET username = ${seed.username} WHERE id = ${intoUserId} AND username IS NULL`;
    }
    await tx`
      INSERT INTO change_log (entity, entity_id, op, before, source, actor_user_id)
      VALUES ('user', ${intoUserId}, 'merge_seed', ${tx.json({ seed_user_id: seedUserId })}, 'admin', ${actorUserId})`;
  });
}
