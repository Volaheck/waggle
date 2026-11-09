interface TelegramWebApp {
  initData: string;
  initDataUnsafe: { start_param?: string };
  colorScheme: "light" | "dark";
  ready(): void;
  onEvent(event: "themeChanged", cb: () => void): void;
  offEvent(event: "themeChanged", cb: () => void): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  setBottomBarColor?(color: string): void;
  expand(): void;
  openTelegramLink(url: string): void;
  openLink(url: string): void;
  HapticFeedback?: { impactOccurred(style: "light" | "medium"): void; notificationOccurred(type: "success" | "error"): void };
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

const DEV_KEY = "chaynaya-dev-login";

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

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { authorization: `tma ${tg?.initData ?? ""}`, "content-type": "application/json" };
  if (devToken) headers["x-dev-login"] = devToken;
  const response = await fetch(`/api${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new ApiError(response.status, payload.error ?? "unknown");
  return payload as T;
}

export function openTelegram(url: string): void {
  if (tg && url.startsWith("https://t.me/")) tg.openTelegramLink(url);
  else if (tg) tg.openLink(url);
  else window.open(url, "_blank");
}

export function haptic(kind: "tap" | "success" | "error" = "tap"): void {
  if (kind === "tap") tg?.HapticFeedback?.impactOccurred("light");
  else tg?.HapticFeedback?.notificationOccurred(kind);
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
  role: "Чем занимается",
  stack: "Стек",
  expertise: "Можно спросить про",
  interest: "Интересы",
  project: "Проекты",
  link: "Ссылки",
  timezone: "Где",
  looking_for: "Ищет",
  can_help: "Может помочь",
};

export const STATUS_EMOJI: Record<string, string> = { идея: "💡", "в работе": "🛠", запущен: "🚀", "на паузе": "⏸", заброшен: "🪦" };
export const STATUSES = ["идея", "в работе", "запущен", "на паузе", "заброшен"] as const;
export const SIGNAL_EMOJI: Record<string, string> = { praise: "❤️", critique: "🧐", usage: "✅", contribution: "🤝", interest: "👀", milestone: "🚀" };
