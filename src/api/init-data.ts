import { createHmac, timingSafeEqual } from "node:crypto";
import type { TelegramIdentity } from "../core/users.js";

const MAX_AGE_SECONDS = 24 * 60 * 60;

export interface ValidatedInitData {
  user: TelegramIdentity;
  startParam: string | null;
  authDate: number;
}

function dataCheckString(params: URLSearchParams): string {
  return [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function sign(params: URLSearchParams, botToken: string): string {
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  return createHmac("sha256", secret).update(dataCheckString(params)).digest("hex");
}

/** Validates Mini App initData: core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app */
export function validateInitData(raw: string, botToken: string, nowSeconds = Math.floor(Date.now() / 1000)): ValidatedInitData | null {
  const params = new URLSearchParams(raw);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const expected = sign(params, botToken);
  if (expected.length !== hash.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(hash))) return null;

  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || nowSeconds - authDate > MAX_AGE_SECONDS) return null;

  const rawUser = params.get("user");
  if (!rawUser) return null;
  let parsed: { id?: unknown; username?: string; first_name?: string; last_name?: string };
  try {
    parsed = JSON.parse(rawUser);
  } catch {
    return null;
  }
  if (typeof parsed.id !== "number") return null;
  return {
    user: { id: parsed.id, username: parsed.username, first_name: parsed.first_name ?? "", last_name: parsed.last_name },
    startParam: params.get("start_param"),
    authDate,
  };
}

export function signInitData(fields: Record<string, string>, botToken: string): string {
  const params = new URLSearchParams(fields);
  params.set("hash", sign(params, botToken));
  return params.toString();
}
