import type { Api } from "grammy";

const TTL_MS = 10 * 60 * 1000;
const MEMBER_STATUSES = new Set(["creator", "administrator", "member"]);

export class MembershipCache {
  private readonly entries = new Map<number, { member: boolean; checkedAt: number }>();

  constructor(
    private readonly api: Api,
    private readonly chatId: number,
  ) {}

  async isMember(tgUserId: number): Promise<boolean> {
    const cached = this.entries.get(tgUserId);
    if (cached && Date.now() - cached.checkedAt < TTL_MS) return cached.member;
    let member = false;
    try {
      const chatMember = await this.api.getChatMember(this.chatId, tgUserId);
      member = MEMBER_STATUSES.has(chatMember.status) || (chatMember.status === "restricted" && chatMember.is_member);
    } catch {
      member = false;
    }
    this.entries.set(tgUserId, { member, checkedAt: Date.now() });
    return member;
  }

  invalidate(tgUserId: number): void {
    this.entries.delete(tgUserId);
  }
}
