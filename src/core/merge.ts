import type { Sql } from "./db.js";
import { moveNotesToUser } from "./notes.js";
import { nameKey } from "./text.js";
import type { User } from "./users.js";

/** A card from imported history that no Telegram account has taken over yet. */
export interface UnlinkedCard {
  id: number;
  display_name: string;
  username: string | null;
  messages: number;
  last_message_at: Date | null;
}

/** How a card's name compares with an account's: the same name, a whole part of it, or nothing alike. */
export type NameMatch = "same" | "part" | "none";

/**
 * The chat's unlinked cards, most recently active first. With `activeWithinDays`, only cards that wrote within that
 * many days; a card without messages (seeded from a file) counts from the day it was imported.
 */
export async function unlinkedCards(sql: Sql, chatId: number, options: { activeWithinDays?: number } = {}): Promise<UnlinkedCard[]> {
  const days = options.activeWithinDays ?? null;
  return sql<UnlinkedCard[]>`
    SELECT u.id, u.display_name, u.username, m.last_message_at,
           (SELECT count(*)::int FROM messages x WHERE x.chat_id = m.chat_id AND x.user_id = u.id) AS messages
    FROM users u JOIN members m ON m.user_id = u.id
    WHERE m.chat_id = ${chatId} AND u.tg_id IS NULL
      AND (${days}::int IS NULL OR coalesce(m.last_message_at, u.created_at) > now() - make_interval(days => ${days}::int))
    ORDER BY m.last_message_at DESC NULLS LAST, u.display_name`;
}

/**
 * Cards ordered by how much their name looks like the account's: the same name first, then a card name that is
 * a whole part of the account's name or @username (or the other way round); ties keep their order.
 */
export function rankCards<T extends Pick<UnlinkedCard, "display_name">>(cards: T[], account: Pick<User, "display_name" | "username">): (T & { match: NameMatch })[] {
  const names = [account.display_name, account.username ?? ""].map(nameKey).filter(Boolean);
  const words = new Set(names.flatMap((name) => name.split(" ")));
  const matchOf = (card: T): NameMatch => {
    const key = nameKey(card.display_name);
    if (!key) return "none";
    if (names.includes(key)) return "same";
    const cardWords = key.split(" ");
    return cardWords.every((word) => words.has(word)) || names.some((name) => cardWords.includes(name)) ? "part" : "none";
  };
  const order: Record<NameMatch, number> = { same: 0, part: 1, none: 2 };
  return cards.map((card) => ({ ...card, match: matchOf(card) })).sort((a, b) => order[a.match] - order[b.match]);
}

/**
 * Folds a seeded card (a user row without a Telegram account) into a real account:
 * memberships, facts, aliases, project roles, votes and messages move over, the seed row disappears.
 */
export async function mergeSeedUser(sql: Sql, seedUserId: number, intoUserId: number, actorUserId: number): Promise<void> {
  await sql.begin(async (tx) => {
    const [seed] = await tx<{ tg_id: number | null; username: string | null }[]>`
      SELECT tg_id, username FROM users WHERE id = ${seedUserId} FOR UPDATE`;
    if (!seed) throw new Error("No such member");
    if (seed.tg_id !== null) throw new Error("This card is already linked to a Telegram account");

    await tx`
      INSERT INTO members (chat_id, user_id, tagline, tagline_manual, opted_out, first_seen_at, last_message_at, left_at, time_zone, time_zone_source, time_zone_set_at)
      SELECT chat_id, ${intoUserId}, tagline, tagline_manual, opted_out, first_seen_at, last_message_at, left_at, time_zone, time_zone_source, time_zone_set_at
      FROM members WHERE user_id = ${seedUserId}
      ON CONFLICT (chat_id, user_id) DO UPDATE SET
        tagline = CASE WHEN members.opted_out OR excluded.opted_out THEN NULL
                       WHEN members.tagline IS NULL OR (NOT members.tagline_manual AND excluded.tagline_manual) THEN excluded.tagline
                       ELSE members.tagline END,
        tagline_manual = NOT (members.opted_out OR excluded.opted_out) AND (members.tagline_manual OR excluded.tagline_manual),
        opted_out = members.opted_out OR excluded.opted_out,
        first_seen_at = least(members.first_seen_at, excluded.first_seen_at),
        last_message_at = greatest(members.last_message_at, excluded.last_message_at),
        time_zone = CASE WHEN members.opted_out OR excluded.opted_out THEN NULL WHEN members.time_zone IS NULL THEN excluded.time_zone ELSE members.time_zone END,
        time_zone_source = CASE WHEN members.opted_out OR excluded.opted_out THEN NULL WHEN members.time_zone IS NULL THEN excluded.time_zone_source ELSE members.time_zone_source END,
        time_zone_set_at = CASE WHEN members.opted_out OR excluded.opted_out THEN NULL
                                WHEN members.time_zone IS NULL AND excluded.time_zone IS NOT NULL THEN excluded.time_zone_set_at
                                ELSE coalesce(members.time_zone_set_at, excluded.time_zone_set_at) END`;
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
    // The account now authors the card's projects, and a vote for one's own project neither counts nor can be taken back.
    await tx`
      DELETE FROM votes v USING project_members pm
      WHERE v.user_id = ${intoUserId} AND pm.user_id = ${intoUserId} AND pm.project_id = v.project_id`;
    await tx`UPDATE messages SET user_id = ${intoUserId} WHERE user_id = ${seedUserId}`;
    await tx`UPDATE project_signals SET user_id = ${intoUserId} WHERE user_id = ${seedUserId}`;
    await tx`
      UPDATE aliases a SET user_id = ${intoUserId}
      WHERE a.user_id = ${seedUserId}
        AND NOT EXISTS (SELECT 1 FROM aliases x WHERE x.chat_id = a.chat_id AND x.user_id = ${intoUserId} AND x.alias_norm = a.alias_norm)`;
    // Chronicle topics list their participants by id, outside any foreign key: the card's place passes to the account, once.
    await tx`
      UPDATE chronicle SET user_ids = (
        SELECT coalesce(array_agg(id ORDER BY first_position), '{}')
        FROM (SELECT id, min(position) AS first_position
              FROM unnest(array_replace(user_ids, ${seedUserId}::int, ${intoUserId}::int)) WITH ORDINALITY AS listed(id, position)
              GROUP BY id) AS participants)
      WHERE ${seedUserId}::int = ANY(user_ids)`;
    // An opt-out on either side wins: in that chat nothing the card knew stays, as when the person opts out themselves.
    await tx`DELETE FROM facts f USING members m WHERE m.user_id = ${intoUserId} AND m.opted_out AND f.chat_id = m.chat_id AND f.user_id = ${intoUserId}`;
    await tx`DELETE FROM rejected_facts r USING members m WHERE m.user_id = ${intoUserId} AND m.opted_out AND r.chat_id = m.chat_id AND r.user_id = ${intoUserId}`;
    await tx`
      DELETE FROM project_signals s USING projects p, members m
      WHERE s.project_id = p.id AND p.chat_id = m.chat_id AND m.user_id = ${intoUserId} AND m.opted_out AND s.user_id = ${intoUserId}`;
    await tx`DELETE FROM aliases a USING members m WHERE m.user_id = ${intoUserId} AND m.opted_out AND a.chat_id = m.chat_id AND a.user_id = ${intoUserId}`;
    await moveNotesToUser(tx, seedUserId, intoUserId);
    // Aliases the account already had are left on the card, and deleting the card deletes those copies.
    await tx`DELETE FROM users WHERE id = ${seedUserId}`;
    if (seed.username) {
      await tx`UPDATE users SET username = ${seed.username} WHERE id = ${intoUserId} AND username IS NULL`;
    }
    await tx`
      INSERT INTO change_log (entity, entity_id, op, before, source, actor_user_id)
      VALUES ('user', ${intoUserId}, 'merge_seed', ${tx.json({ seed_user_id: seedUserId })}, 'admin', ${actorUserId})`;
  });
}
