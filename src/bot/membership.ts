import type { Api } from "grammy";

const TTL_MS = 10 * 60 * 1000;
const MEMBER_STATUSES = new Set(["creator", "administrator", "member"]);
const ADMIN_STATUSES = new Set(["creator", "administrator"]);

interface Entry {
  member: boolean;
  admin: boolean;
  checkedAt: number;
}

/** Asks Telegram whether someone is in a chat, remembering the answer for a few minutes. */
export class MembershipCache {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly api: Api) {}

  private async lookup(chatId: number, tgUserId: number): Promise<Entry> {
    const key = `${chatId}:${tgUserId}`;
    const cached = this.entries.get(key);
    if (cached && Date.now() - cached.checkedAt < TTL_MS) return cached;
    let entry: Entry = { member: false, admin: false, checkedAt: Date.now() };
    try {
      const chatMember = await this.api.getChatMember(chatId, tgUserId);
      entry = {
        member: MEMBER_STATUSES.has(chatMember.status) || (chatMember.status === "restricted" && chatMember.is_member),
        admin: ADMIN_STATUSES.has(chatMember.status),
        checkedAt: Date.now(),
      };
    } catch {
      // Unknown chat or user: treat as not a member.
    }
    this.entries.set(key, entry);
    return entry;
  }

  async isMember(chatId: number, tgUserId: number): Promise<boolean> {
    return (await this.lookup(chatId, tgUserId)).member;
  }

  async isChatAdmin(chatId: number, tgUserId: number): Promise<boolean> {
    return (await this.lookup(chatId, tgUserId)).admin;
  }

  invalidate(chatId: number, tgUserId: number): void {
    this.entries.delete(`${chatId}:${tgUserId}`);
  }
}
