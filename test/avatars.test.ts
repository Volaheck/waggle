import type { Api } from "grammy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AvatarCache, avatarPath, avatarSignature, isAvatarSignature } from "../src/api/avatars.js";

const SECRET = "123456:TEST-TOKEN";

describe("avatar URLs", () => {
  it("are signed per user and checked in constant time", () => {
    const path = avatarPath(SECRET, 42);
    const signature = new URL(path, "https://x.test").searchParams.get("s")!;
    expect(path.startsWith("/avatars/42?s=")).toBe(true);
    expect(isAvatarSignature(SECRET, 42, signature)).toBe(true);
    expect(isAvatarSignature(SECRET, 43, signature)).toBe(false);
    expect(isAvatarSignature("other-token", 42, signature)).toBe(false);
    expect(isAvatarSignature(SECRET, 42, undefined)).toBe(false);
    expect(avatarSignature(SECRET, 42)).not.toBe(avatarSignature(SECRET, 43));
  });
});

describe("AvatarCache", () => {
  afterEach(() => vi.unstubAllGlobals());

  const fakeApi = (photos: { width: number; file_id: string }[][], failing = false) => {
    const api = {
      getUserProfilePhotos: vi.fn(async () => {
        if (failing) throw new Error("Forbidden");
        return { total_count: photos.length, photos };
      }),
      getFile: vi.fn(async (fileId: string) => ({ file_id: fileId, file_path: `photos/${fileId}.jpg` })),
    };
    return api;
  };

  it("fetches the small size once and serves it from memory", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal("fetch", fetchMock);
    const api = fakeApi([[{ width: 640, file_id: "big" }, { width: 160, file_id: "small" }, { width: 320, file_id: "mid" }]]);
    const cache = new AvatarCache(api as unknown as Api, SECRET);
    const [first, second] = await Promise.all([cache.get(7), cache.get(7)]);
    expect(first?.type).toBe("image/jpeg");
    expect(new Uint8Array(first!.bytes)).toEqual(new Uint8Array([1, 2, 3]));
    expect(second).toBe(first);
    expect(await cache.get(7)).toBe(first);
    expect(api.getUserProfilePhotos).toHaveBeenCalledTimes(1);
    expect(api.getFile).toHaveBeenCalledWith("small");
    expect(fetchMock).toHaveBeenCalledWith(`https://api.telegram.org/file/bot${SECRET}/photos/small.jpg`);
  });

  it("returns null for a hidden photo or a Telegram error", async () => {
    vi.stubGlobal("fetch", vi.fn());
    expect(await new AvatarCache(fakeApi([]) as unknown as Api, SECRET).get(8)).toBeNull();
    expect(await new AvatarCache(fakeApi([], true) as unknown as Api, SECRET).get(9)).toBeNull();
  });
});
