import { GrammyError, type Api } from "grammy";
import type { ChatMember } from "grammy/types";

const TTL_MS = 10 * 60 * 1000;
const MEMBER_STATUSES = new Set(["creator", "administrator", "member"]);
const ADMIN_STATUSES = new Set(["creator", "administrator"]);

/** "unknown": Telegram could not be asked (network, rate limit, the bot is not in the chat). */
export type Membership = "member" | "left" | "unknown";

interface Entry {
  state: Exclude<Membership, "unknown">;
  admin: boolean;
  checkedAt: number;
}

/** In the chat, by Telegram's own rule: a restricted user who left keeps status "restricted" with is_member false. */
export function isInChat(member: Pick<ChatMember, "status"> & { is_member?: boolean }): boolean {
  return MEMBER_STATUSES.has(member.status) || (member.status === "restricted" && member.is_member === true);
}

/** Asks Telegram whether someone is in a chat, remembering definite answers for a few minutes. */
export class MembershipCache {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly api: Api) {}

  private async lookup(chatId: number, tgUserId: number): Promise<Entry | undefined> {
    const key = `${chatId}:${tgUserId}`;
    const cached = this.entries.get(key);
    if (cached && Date.now() - cached.checkedAt < TTL_MS) return cached;
    let entry: Entry;
    try {
      const chatMember = await this.api.getChatMember(chatId, tgUserId);
      entry = { state: isInChat(chatMember) ? "member" : "left", admin: ADMIN_STATUSES.has(chatMember.status), checkedAt: Date.now() };
    } catch (error) {
      // Telegram answers this way for an account that is not in the chat; any other failure says nothing about the person.
      if (!(error instanceof GrammyError && error.error_code === 400 && /user not found|participant_id_invalid|member not found/i.test(error.description))) return undefined;
      entry = { state: "left", admin: false, checkedAt: Date.now() };
    }
    this.entries.set(key, entry);
    return entry;
  }

  async status(chatId: number, tgUserId: number): Promise<Membership> {
    return (await this.lookup(chatId, tgUserId))?.state ?? "unknown";
  }

  /** Only a confirmed member counts: when Telegram can't be asked, access is refused. */
  async isMember(chatId: number, tgUserId: number): Promise<boolean> {
    return (await this.status(chatId, tgUserId)) === "member";
  }

  async isChatAdmin(chatId: number, tgUserId: number): Promise<boolean> {
    return (await this.lookup(chatId, tgUserId))?.admin ?? false;
  }

  invalidate(chatId: number, tgUserId: number): void {
    this.entries.delete(`${chatId}:${tgUserId}`);
  }
}
