interface TelegramWebApp {
  initData: string;
  initDataUnsafe: { start_param?: string };
  colorScheme: "light" | "dark";
  version?: string;
  ready(): void;
  isVersionAtLeast?(version: string): boolean;
  onEvent(event: string, cb: () => void): void;
  offEvent(event: string, cb: () => void): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  setBottomBarColor?(color: string): void;
  expand(): void;
  openTelegramLink(url: string): void;
  openLink(url: string): void;
  showAlert?(message: string, cb?: () => void): void;
  showConfirm?(message: string, cb?: (ok: boolean) => void): void;
  HapticFeedback?: {
    impactOccurred(style: "light" | "medium"): void;
    notificationOccurred(type: "success" | "error"): void;
    selectionChanged?(): void;
  };
  BackButton: { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void };
}

declare global {
  interface Window {
    Telegram?: { WebApp: TelegramWebApp };
  }
}

export const tg: TelegramWebApp | undefined = window.Telegram?.WebApp;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    /** The rest of the error body, e.g. the slug of the project a 409 "exists" points at. */
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

const DEV_KEY = "waggle-dev-login";

/** Local development: `/app/?dev=<secret>` from the server log lets a plain browser in. */
function devLoginToken(): string | null {
  const fromUrl = new URLSearchParams(window.location.search).get("dev");
  try {
    if (fromUrl) sessionStorage.setItem(DEV_KEY, fromUrl);
    return fromUrl ?? sessionStorage.getItem(DEV_KEY);
  } catch {
    return fromUrl;
  }
}

const devToken = tg?.initData ? null : devLoginToken();

/** The chat a screen is about: «c100123» from the start param (t.me/bot/app?startapp=c100123_me) or ?chat= in DM links. */
export function chatFromLaunch(): string | null {
  const fromStart = /^(c\d+)(?:_|$)/.exec(tg?.initDataUnsafe.start_param ?? "")?.[1];
  return fromStart ?? new URLSearchParams(window.location.search).get("chat");
}

/** Start param without the chat prefix: «c100123_p_atlas» → «p_atlas». */
export function screenFromLaunch(): string | undefined {
  return tg?.initDataUnsafe.start_param?.replace(/^c\d+_?/, "") || undefined;
}

let currentChat: string | null = chatFromLaunch();

export function setCurrentChat(key: string | null): void {
  currentChat = key;
}

export function getCurrentChat(): string | null {
  return currentChat;
}

export interface ChatInfo {
  key: string;
  title: string | null;
}

/** Requests in flight; the top-bar mark breathes while the chronicler fetches. */
let inFlight = 0;
function track(delta: number): void {
  inFlight += delta;
  document.documentElement.toggleAttribute("data-busy", inFlight > 0);
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { authorization: `tma ${tg?.initData ?? ""}`, "content-type": "application/json" };
  if (devToken) headers["x-dev-login"] = devToken;
  if (currentChat && path !== "/chats") headers["x-chat-id"] = currentChat;
  track(1);
  try {
    const response = await fetch(`/api${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const payload = (await response.json().catch(() => ({}))) as { error?: string } & Record<string, unknown>;
    if (!response.ok) throw new ApiError(response.status, payload.error ?? "unknown", payload);
    return payload as T;
  } finally {
    track(-1);
  }
}

export function openTelegram(url: string): void {
  if (tg && url.startsWith("https://t.me/")) tg.openTelegramLink(url);
  else if (tg) tg.openLink(url);
  else window.open(url, "_blank");
}

export function haptic(kind: "tap" | "select" | "success" | "error" = "tap"): void {
  if (kind === "tap") tg?.HapticFeedback?.impactOccurred("light");
  else if (kind === "select") tg?.HapticFeedback?.selectionChanged?.();
  else tg?.HapticFeedback?.notificationOccurred(kind);
}

/** Telegram's own popups exist from Bot API 6.2; outside Telegram (or older clients) the browser's dialogs stand in. */
function popups(): TelegramWebApp | null {
  return tg?.initData && tg.isVersionAtLeast?.("6.2") ? tg : null;
}

export function tgAlert(message: string): void {
  const app = popups();
  if (!app?.showAlert) {
    window.alert(message);
    return;
  }
  try {
    app.showAlert(message);
  } catch {
    // Telegram throws while another popup is open; that popup already has the person's attention.
  }
}

export function tgConfirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const app = popups();
    if (!app?.showConfirm) {
      resolve(window.confirm(message));
      return;
    }
    try {
      app.showConfirm(message, (ok) => resolve(Boolean(ok)));
    } catch {
      resolve(false);
    }
  });
}

export interface Source {
  id: number;
  url: string;
}

/** A note its author wrote, about themselves or about a project of theirs. */
export interface Memo {
  id: number;
  user_id: number;
  project_id: number | null;
  text: string;
  created_at: string;
  /** The project it is on, in its author's own list. */
  project_name?: string | null;
  /** Its author, on a project's page. */
  display_name?: string;
}

export interface Fact {
  id: number;
  kind: string;
  value: string;
  confidence: number;
  status: "auto" | "manual" | "hidden" | "deprecated";
  sources: Source[];
}

export interface PersonSummary {
  id: number;
  display_name: string;
  username: string | null;
  tagline: string | null;
  opted_out: boolean;
  linked: boolean;
  /** The person's Telegram photo; it answers 404 when they have none or hide it. */
  avatar_url?: string | null;
  top_facts: string[];
  project_count: number;
}

export interface ProjectSignal {
  kind: string;
  note: string;
  msg_id: number | null;
}

export interface Project {
  id: number;
  slug: string;
  name: string;
  tagline: string | null;
  status: string;
  stack: string[];
  links: { repo?: string | null; site?: string | null; other?: string[] };
  authors: { id: number; display_name: string; username: string | null; role: string | null; avatar_url?: string | null }[];
  votes: number;
  score: number;
  voted_by_me: boolean;
  recent_signals: ProjectSignal[];
  signals_count?: number;
  last_activity_at?: string | null;
}

export interface ChronicleEntry {
  id: number;
  title: string;
  summary: string;
  kind: "discussion" | "project" | "link" | "news" | "debate";
  importance: number;
  period_to: string;
  url: string | null;
}

/** The zone on the member's card in this chat, and the clock they go by (src/core/zones.ts). */
export interface TimeZoneInfo {
  /** The zone they chose or their device gave; null when there is none. */
  chosen: string | null;
  source: "chat" | "app" | "device" | null;
  /** When it was set or cleared; null on a card that never had one. */
  set_at: string | null;
  /** The zone their times are shown in. */
  zone: string;
  from: "chat" | "app" | "device" | "card" | "chat_zone";
  /** The place on their card the zone follows, or one that spans several zones. */
  place: string | null;
  /** How many zones that place spans, when it spans several. */
  unclear: number | null;
  /** Those zones, to pick from. */
  choices: string[];
  chat_zone: string;
}

/** The device's IANA zone; UTC when the runtime cannot tell. */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** A zone this browser can show times in; undefined (the device's own) for one it does not know. */
export function usableZone(zone: string | null | undefined): string | undefined {
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

/** Every zone this browser knows, for the picker; UTC always, though some browsers leave it out of their list. */
export function knownZones(): string[] {
  try {
    if (typeof Intl.supportedValuesOf === "function") {
      const zones = Intl.supportedValuesOf("timeZone");
      return zones.includes("UTC") ? zones : ["UTC", ...zones];
    }
  } catch {
    // An older runtime: the picker offers what the card and the device give.
  }
  return ["UTC"];
}

/** A zone as people read it: Etc/GMT-7 is UTC+7 (the Etc names count the other way round), anything else its name. */
export function zoneLabel(zone: string): string {
  const fixed = /^Etc\/(?:GMT|UTC)(?:([+-])(\d{1,2}))?$/.exec(zone);
  if (!fixed) return zone;
  if (!fixed[1] || fixed[2] === "0") return "UTC";
  return `UTC${fixed[1] === "-" ? "+" : "−"}${fixed[2]}`;
}

/** Cities many browsers still list under an older name, with the names a zone may have. */
const RENAMED: Record<string, string[]> = {
  kyiv: ["Europe/Kyiv", "Europe/Kiev"],
  kolkata: ["Asia/Kolkata", "Asia/Calcutta"],
  "ho chi minh": ["Asia/Ho_Chi_Minh", "Asia/Saigon"],
  kathmandu: ["Asia/Kathmandu", "Asia/Katmandu"],
  yangon: ["Asia/Yangon", "Asia/Rangoon"],
  nuuk: ["America/Nuuk", "America/Godthab"],
  chuuk: ["Pacific/Chuuk", "Pacific/Truk"],
  pohnpei: ["Pacific/Pohnpei", "Pacific/Ponape"],
};

/** UTC+7 or GMT-3 as a zone of its own, Etc/GMT-7 (the Etc names count the other way round); null for anything else. */
function offsetZone(text: string): string | null {
  const match = /^(?:utc|gmt)\s*(?:([+−–-])\s*(\d{1,2})(?::?00)?)?$/i.exec(text.trim());
  if (!match) return null;
  if (!match[1] || Number(match[2]) === 0) return "UTC";
  const hours = Number(match[2]);
  const east = match[1] === "+";
  return hours > (east ? 14 : 12) ? null : `Etc/GMT${east ? "-" : "+"}${hours}`;
}

/** The zones a search finds: an offset written as one, cities known under an older name, then every name that holds the words. */
export function searchZones(query: string, zones: string[]): string[] {
  const words = query.trim().toLowerCase().replace(/[\s_]+/g, " ");
  if (!words) return [];
  const offset = offsetZone(words);
  const renamed = Object.entries(RENAMED)
    .filter(([city]) => city.startsWith(words) || words.startsWith(city))
    .flatMap(([, names]) => names.find((name) => zones.includes(name)) ?? names.find((name) => usableZone(name)) ?? []);
  const named = zones.filter((zone) => zone.toLowerCase().replace(/_/g, " ").includes(words));
  return [...new Set([...(offset && usableZone(offset) ? [offset] : []), ...renamed, ...named])].slice(0, 30);
}

function offsetName(zone: string, at: Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" }).formatToParts(at).find((part) => part.type === "timeZoneName")?.value ?? "";
}

/** Whether two zones show the same time all year round, whatever their names (Europe/Kyiv and Europe/Kiev). */
export function sameClock(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    const now = Date.now();
    return [0, 1, 2, 3].every((quarter) => {
      const at = new Date(now + quarter * 91 * 86_400_000);
      return offsetName(a, at) === offsetName(b, at);
    });
  } catch {
    return false;
  }
}

export const FACT_LABELS: Record<string, string> = {
  role: "Role",
  stack: "Stack",
  expertise: "Ask about",
  interest: "Interests",
  project: "Projects",
  link: "Links",
  timezone: "Based in",
  looking_for: "Looking for",
  can_help: "Can help with",
};

/** Project status codes, exactly as the API stores and validates them. */
export const STATUSES = ["idea", "in_progress", "launched", "paused", "abandoned"] as const;
