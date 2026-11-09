import type { Api } from "grammy";
import type { Sql } from "../core/db.js";
import { markLeft, resolveUser } from "../core/users.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const REQUEST_GAP_MS = 120;

/**
 * Names shown everywhere are the ones people set for themselves in Telegram.
 * Messages refresh them for active members; this pass also covers silent ones and renames.
 */
export async function syncMemberNames(api: Api, sql: Sql, chatId: number, adminTgIds: number[]): Promise<{ updated: number; left: number }> {
  const known = await sql<{ tg_id: number }[]>`SELECT tg_id FROM users WHERE tg_id IS NOT NULL AND left_at IS NULL`;
  let updated = 0;
  let left = 0;
  for (const { tg_id: tgId } of known) {
    try {
      const member = await api.getChatMember(chatId, tgId);
      if (member.status === "left" || member.status === "kicked") {
        await markLeft(sql, tgId);
        left += 1;
      } else {
        await resolveUser(sql, member.user, adminTgIds);
        updated += 1;
      }
    } catch {
      // Telegram may refuse for deleted accounts; keep the stored name.
    }
    await new Promise((resolve) => setTimeout(resolve, REQUEST_GAP_MS));
  }
  return { updated, left };
}

export function startNameSync(api: Api, sql: Sql, chatId: number, adminTgIds: number[], log: (line: string) => void = console.log): () => void {
  const run = () =>
    syncMemberNames(api, sql, chatId, adminTgIds)
      .then((result) => log(`[names] refreshed: ${result.updated}, left the chat: ${result.left}`))
      .catch((error) => log(`[names] sync failed: ${String(error)}`));
  void run();
  const timer = setInterval(run, DAY_MS);
  return () => clearInterval(timer);
}
