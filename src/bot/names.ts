import type { Api } from "grammy";
import { approvedChats } from "../core/chats.js";
import type { Sql } from "../core/db.js";
import { markLeft, resolveUser } from "../core/users.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const REQUEST_GAP_MS = 120;

/**
 * Names shown everywhere are the ones people set for themselves in Telegram.
 * Messages refresh them for active members; this pass also covers silent ones, renames and leavers.
 */
export async function syncMemberNames(api: Api, sql: Sql, chatId: number, adminTgIds: number[]): Promise<{ updated: number; left: number }> {
  const known = await sql<{ tg_id: number }[]>`
    SELECT u.tg_id FROM users u JOIN members m ON m.user_id = u.id
    WHERE m.chat_id = ${chatId} AND m.left_at IS NULL AND u.tg_id IS NOT NULL`;
  let updated = 0;
  let left = 0;
  for (const { tg_id: tgId } of known) {
    try {
      const member = await api.getChatMember(chatId, tgId);
      if (member.status === "left" || member.status === "kicked") {
        await markLeft(sql, chatId, tgId);
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

export function startNameSync(api: Api, sql: Sql, adminTgIds: number[], log: (line: string) => void = console.log): () => void {
  const run = async () => {
    for (const chat of await approvedChats(sql)) {
      try {
        const result = await syncMemberNames(api, sql, chat.id, adminTgIds);
        log(`[names] ${chat.title ?? chat.id}: refreshed ${result.updated}, left ${result.left}`);
      } catch (error) {
        log(`[names] ${chat.title ?? chat.id}: sync failed: ${String(error)}`);
      }
    }
  };
  void run().catch((error) => log(`[names] sync failed: ${String(error)}`));
  const timer = setInterval(() => void run().catch((error) => log(`[names] sync failed: ${String(error)}`)), DAY_MS);
  return () => clearInterval(timer);
}
