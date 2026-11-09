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
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) throw new ApiError(response.status, payload.error ?? "unknown");
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
  authors: { id: number; display_name: string; username: string | null; role: string | null }[];
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
  kind: "discussion" | "project" | "link" | "news";
  importance: number;
  period_to: string;
  url: string | null;
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

export const STATUSES = ["идея", "в работе", "запущен", "на паузе", "заброшен"] as const;
