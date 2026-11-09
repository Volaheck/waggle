import { createHmac, timingSafeEqual } from "node:crypto";
import type { Api } from "grammy";

const TTL_MS = 24 * 60 * 60 * 1000;
/** No photo, or hidden by the person's privacy settings: ask Telegram again a few hours later. */
const EMPTY_TTL_MS = 6 * 60 * 60 * 1000;
const ERROR_TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 1000;
/** Telegram's small profile-photo size (160 px) is plenty for 40–64 px avatars. */
const WANTED_SIZE = 160;

export interface Avatar {
  bytes: ArrayBuffer;
  type: string;
}

interface Entry {
  avatar: Avatar | null;
  expiresAt: number;
}

/**
 * Members' Telegram profile photos for the Mini App, fetched through the Bot API and kept in memory.
 * After a restart they are simply fetched again; nothing is stored in the database.
 */
export class AvatarCache {
  private readonly entries = new Map<number, Entry>();
  private readonly pending = new Map<number, Promise<Avatar | null>>();

  constructor(
    private readonly api: Api,
    private readonly botToken: string,
  ) {}

  async get(tgId: number): Promise<Avatar | null> {
    const cached = this.entries.get(tgId);
    if (cached && cached.expiresAt > Date.now()) return cached.avatar;
    const inFlight = this.pending.get(tgId);
    if (inFlight) return inFlight;
    const request = this.fetch(tgId).finally(() => this.pending.delete(tgId));
    this.pending.set(tgId, request);
    return request;
  }

  private remember(tgId: number, avatar: Avatar | null, ttl: number): Avatar | null {
    this.entries.delete(tgId);
    this.entries.set(tgId, { avatar, expiresAt: Date.now() + ttl });
    while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
    return avatar;
  }

  private async fetch(tgId: number): Promise<Avatar | null> {
    try {
      const { photos } = await this.api.getUserProfilePhotos(tgId, { limit: 1 });
      const sizes = photos[0];
      if (!sizes?.length) return this.remember(tgId, null, EMPTY_TTL_MS);
      const size = [...sizes].sort((a, b) => a.width - b.width).find((candidate) => candidate.width >= WANTED_SIZE) ?? sizes[sizes.length - 1]!;
      const file = await this.api.getFile(size.file_id);
      if (!file.file_path) return this.remember(tgId, null, EMPTY_TTL_MS);
      const response = await fetch(`https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`);
      if (!response.ok) return this.remember(tgId, null, ERROR_TTL_MS);
      const bytes = await response.arrayBuffer();
      const type = file.file_path.endsWith(".png") ? "image/png" : "image/jpeg";
      return this.remember(tgId, { bytes, type }, TTL_MS);
    } catch {
      return this.remember(tgId, null, ERROR_TTL_MS);
    }
  }
}

/**
 * Avatar URLs are signed, so nobody can walk user ids and collect the photos of every chat's members;
 * only people who were given a card (members of the same chat) get the URL.
 */
export function avatarSignature(secret: string, userId: number): string {
  return createHmac("sha256", secret).update(`avatar:${userId}`).digest("base64url").slice(0, 22);
}

export function avatarPath(secret: string, userId: number): string {
  return `/avatars/${userId}?s=${avatarSignature(secret, userId)}`;
}

export function isAvatarSignature(secret: string, userId: number, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = Buffer.from(avatarSignature(secret, userId));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
