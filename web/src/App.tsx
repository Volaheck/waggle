import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  type TextareaHTMLAttributes,
} from "react";
import {
  api,
  ApiError,
  chatFromLaunch,
  FACT_LABELS,
  getCurrentChat,
  haptic,
  openTelegram,
  screenFromLaunch,
  setCurrentChat,
  STATUSES,
  tg,
  tgAlert,
  tgConfirm,
  type ChatInfo,
  type ChronicleEntry,
  type Fact,
  type Memo,
  type PersonSummary,
  type Project,
} from "./api";
import { HexBackdrop, HexMark } from "./HexBackdrop";

type Go = (to: string) => void;

// ---------- icons: one language with the landing — 24 grid, 1.8 stroke, round caps ----------

const ICON = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", viewBox: "0 0 24 24", "aria-hidden": true } as const;

type IconName =
  | "eyeOff"
  | "close"
  | "restore"
  | "pen"
  | "check"
  | "chevron"
  | "arrowUpRight"
  | "plus"
  | "vote"
  | "heart"
  | "bolt"
  | "users"
  | "eye"
  | "message"
  | "globe"
  | "code"
  | "telegram"
  | "hex"
  | "retry"
  | "back";

const PATHS: Record<IconName, ReactNode> = {
  eyeOff: (
    <>
      <path d="M3 3l18 18" />
      <path d="M10.6 5.2A9.6 9.6 0 0 1 12 5c5 0 8.6 4.4 9.6 7a12.6 12.6 0 0 1-2.7 3.8M6.5 6.6C4.4 8 3 10.1 2.4 12c1 2.6 4.6 7 9.6 7 1.6 0 3.1-.4 4.4-1.1" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6 6 18" />,
  restore: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </>
  ),
  pen: (
    <>
      <path d="M4 20h4L19 9l-4-4L4 16v4Z" />
      <path d="m13.5 6.5 4 4" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  chevron: <path d="m6 9 6 6 6-6" />,
  arrowUpRight: <path d="M7 17 17 7M8 7h9v9" />,
  plus: <path d="M12 5v14M5 12h14" />,
  vote: (
    <>
      <path d="M12 3l7.5 4.3v9.4L12 21l-7.5-4.3V7.3z" />
      <path d="M12 15.5V9M9.2 11.6 12 8.8l2.8 2.8" />
    </>
  ),
  heart: <path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7Z" />,
  bolt: <path d="M13 2 4.5 13.5H11L9.5 22 19 10h-6.5L13 2Z" />,
  users: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 20a5.5 5.5 0 0 1 11 0M16 6.5a3 3 0 0 1 0 6M17 15.5a5.5 5.5 0 0 1 3.5 4.5" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7S2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  message: (
    <>
      <path d="M4 5h16v11H8l-4 4V5Z" />
      <path d="M8 9.5h8M8 12.5h5" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3.6 9h16.8M3.6 15h16.8M12 3a15.3 15.3 0 0 1 0 18M12 3a15.3 15.3 0 0 0 0 18" />
    </>
  ),
  code: <path d="m8 7-5 5 5 5M16 7l5 5-5 5" />,
  telegram: <path d="M21.5 4.5 2.9 11.7c-.8.3-.8 1.4.05 1.7l4.7 1.6 1.8 5.5c.25.8 1.3.95 1.8.3l2.6-3.4 4.8 3.5c.7.5 1.7.1 1.85-.75l2.6-14.1c.15-.9-.7-1.6-1.6-1.25Z" />,
  hex: <path d="M12 3l7.5 4.3v9.4L12 21l-7.5-4.3V7.3z" />,
  retry: <path d="M21 12a9 9 0 1 1-2.6-6.3M21 4v5h-5" />,
  back: <path d="M19 12H5M11 18l-6-6 6-6" />,
};

function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg {...ICON} className={className}>
      {PATHS[name]}
    </svg>
  );
}

// ---------- small helpers ----------

const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ") || undefined;

/** Chat content is Russian or English; tagging Cyrillic lets the browser hyphenate and speak it right. */
const langOf = (text?: string | null) => (text && /[Ѐ-ӿ]/.test(text) ? "ru" : undefined);

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

const prettyUrl = (url: string) => url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
const linkIcon = (url: string): IconName => (url.startsWith("https://t.me/") ? "telegram" : /github\.com|gitlab\.com|codeberg\.org/.test(url) ? "code" : "globe");
/** People type links without a scheme ("github.com/…"); the API and the browser need a full URL. */
const withScheme = (url: string) => (!url || /^([a-z][a-z\d+.-]*:\/\/|mailto:)/i.test(url) ? url : `https://${url}`);
/** A link fact as something to open: the server stores whatever a member typed, so only http(s) becomes a link. */
const openableUrl = (value: string): string | null => {
  const url = withScheme(value.trim());
  return /^https?:\/\//i.test(url) ? url : null;
};

const URL_INPUT = { type: "url", inputMode: "url", autoCapitalize: "none", autoCorrect: "off", spellCheck: false, enterKeyHint: "done" } as const;

/** A row or card that acts like a button: tap, Enter and Space, with a light haptic. */
function pressable(onPress: () => void) {
  return {
    role: "button" as const,
    tabIndex: 0,
    onClick: () => {
      haptic();
      onPress();
    },
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      haptic();
      onPress();
    },
  };
}

// ---------- routing: hash routes, scroll memory, and whether we went forward or back ----------

function routeFromStartParam(param: string | undefined): string | null {
  if (!param) return null;
  if (param.startsWith("u_")) return `/u/${param.slice(2)}`;
  if (param.startsWith("p_")) return `/p/${param.slice(2)}`;
  if (["me", "projects", "people", "chronicle"].includes(param)) return `/${param}`;
  return null;
}

type NavKind = "forward" | "back";

/** Telegram puts its own data into the hash (#tgWebAppData=…); only "#/…" is a route. */
function readRoute(): string {
  const hash = window.location.hash.replace(/^#/, "");
  return hash.startsWith("/") ? hash : "/people";
}

/**
 * A launch link (startapp=c…_p_slug) opens its screen in place of Telegram's launch entry, unstamped like a DM link,
 * so Back goes up to the screen's section instead of to a People list nobody saw.
 */
function launchRoute(): string {
  const start = routeFromStartParam(screenFromLaunch());
  if (start && !window.location.hash.startsWith("#/")) window.history.replaceState(window.history.state, "", `#${start}`);
  return readRoute();
}

/** Scroll is remembered per screen; a one-shot flag like ?add must not split it. */
const screenOf = (route: string) => route.split("?")[0] ?? route;

/** Screens the app opened itself are stamped in history; a deep link from a DM starts on an unstamped entry. */
const openedInApp = () => (window.history.state as { inApp?: boolean } | null)?.inApp === true;

/** Back to the previous screen, or, when the app has none behind (a deep link), up to the section this screen belongs to. */
function goUp(): void {
  if (openedInApp()) window.history.back();
  else window.location.replace(`#${readRoute().startsWith("/p/") ? "/projects" : "/people"}`);
}

function useRoute(): { route: string; kind: NavKind; go: Go } {
  const [state, setState] = useState<{ route: string; kind: NavKind }>(() => ({ route: launchRoute(), kind: "forward" }));
  const forward = useRef(false);
  const current = useRef(state.route);
  const positions = useRef(new Map<string, number>());

  useEffect(() => {
    window.history.scrollRestoration = "manual";
    const onChange = () => {
      positions.current.set(screenOf(current.current), window.scrollY);
      if (forward.current) window.history.replaceState({ ...window.history.state, inApp: true }, "");
      const route = readRoute();
      current.current = route;
      setState({ route, kind: forward.current ? "forward" : "back" });
      forward.current = false;
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  useLayoutEffect(() => {
    window.scrollTo(0, state.kind === "back" ? (positions.current.get(screenOf(state.route)) ?? 0) : 0);
  }, [state]);

  const go = useCallback((to: string) => {
    if (`#${to}` === window.location.hash) {
      window.scrollTo({ top: 0, behavior: reducedMotion() ? "auto" : "smooth" });
      return;
    }
    forward.current = true;
    window.location.hash = to;
  }, []);

  return { ...state, go };
}

// ---------- data: stale-while-revalidate per chat ----------

const cache = new Map<string, unknown>();

/** `once`: a cached answer is good enough, don't ask again (who the viewer is doesn't change mid-session). */
function useLoad<T>(path: string | null, { once = false }: { once?: boolean } = {}) {
  const key = path === null ? null : path === "/chats" ? path : `${getCurrentChat() ?? "-"} ${path}`;
  const [state, setState] = useState<{ key: string | null; data: T | null }>(() => ({ key, data: key ? ((cache.get(key) as T | undefined) ?? null) : null }));
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!path || !key || (once && cache.has(key))) return;
    let cancelled = false;
    setError(null);
    api<T>(path)
      .then((result) => {
        cache.set(key, result);
        if (!cancelled) setState({ key, data: result });
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.code : "network");
      });
    return () => {
      cancelled = true;
    };
  }, [key, tick]);

  const cached = key ? (cache.get(key) as T | undefined) : undefined;
  const fresh = state.key === key;
  // The cache can fill between the first render and the effect (another screen's request landing); a `once` load then never sets state.
  const data = fresh ? (state.data ?? cached ?? null) : (cached ?? state.data);
  const dataKey = fresh || cached !== undefined ? key : state.key;
  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { data, error, reload, pending: data !== null && dataKey !== key, dataPath: dataKey?.split(" ").pop() ?? null };
}

const remembered = new Map<string, unknown>();

/** View state (sort, period, an open explainer) that outlives the screen: every route remounts it, and Back must land in the same list. */
function useRemembered<T>(name: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => (remembered.has(name) ? (remembered.get(name) as T) : initial));
  const set = useCallback(
    (next: T) => {
      remembered.set(name, next);
      setValue(next);
    },
    [name],
  );
  return [value, set];
}

// ---------- theme ----------

const THEME_BG = { dark: "#0d0e12", light: "#f6f5ef" } as const;

function useTelegramTheme() {
  useEffect(() => {
    // Outside Telegram the SDK still exists but always reports "light", so trust it only inside Telegram.
    const insideTelegram = Boolean(tg?.initData);
    const apply = () => {
      const scheme = insideTelegram ? tg!.colorScheme : window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
      document.documentElement.dataset.theme = scheme;
      document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_BG[scheme]);
      tg?.setHeaderColor?.(THEME_BG[scheme]);
      tg?.setBackgroundColor?.(THEME_BG[scheme]);
      tg?.setBottomBarColor?.(THEME_BG[scheme]);
    };
    apply();
    if (insideTelegram) {
      tg!.onEvent("themeChanged", apply);
      return () => tg?.offEvent("themeChanged", apply);
    }
    const media = window.matchMedia("(prefers-color-scheme: light)");
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);
}

/** The landing's typewriter cadence: new terminal text types itself in, the caret riding along. */
function useTyped(text: string, instant: boolean): string {
  const [shown, setShown] = useState(text);
  const previous = useRef(text);
  useEffect(() => {
    if (previous.current === text) return;
    previous.current = text;
    if (instant || reducedMotion()) {
      setShown(text);
      return;
    }
    let count = 0;
    let timer = 0;
    const type = () => {
      count += 1;
      setShown(text.slice(0, count));
      if (count < text.length) timer = window.setTimeout(type, 24 + Math.random() * 24);
    };
    type();
    return () => window.clearTimeout(timer);
  }, [text, instant]);
  return shown;
}

// ---------- the landing's grammar: [ eyebrow ] → title with one accent word → > terminal ----------

/** The terminal's punctuation ("> ", "// ") is decoration; screen readers skip it. */
function Glyph({ children }: { children: string }) {
  return <span aria-hidden>{children} </span>;
}

function Eyebrow({ text }: { text: string }) {
  return (
    <div className="eyebrow" style={{ ["--n" as string]: text.length + 4 }}>
      <span aria-hidden>[ </span>
      {text}
      <span aria-hidden> ]</span>
    </div>
  );
}

function Terminal({ text, typed }: { text: string; typed?: string }) {
  return (
    <div className="terminal">
      <span className="prompt" aria-hidden>
        &gt;
      </span>
      {typed === undefined ? (
        <span className="t-text">{text}</span>
      ) : (
        <>
          <span className="t-text" aria-hidden>
            {typed}
          </span>
          <span className="sr-only">{text}</span>
        </>
      )}
      <span className="caret" aria-hidden />
    </div>
  );
}

function Title({ eyebrow, children, terminal, pending = false, action }: { eyebrow: string; children: ReactNode; terminal?: string; pending?: boolean; action?: ReactNode }) {
  const typed = useTyped(terminal ?? "", pending);
  return (
    <div className="screen-head">
      <Eyebrow text={eyebrow} />
      {action && <div className="head-action">{action}</div>}
      <h1 className="title">{children}</h1>
      {terminal !== undefined && <Terminal text={terminal} typed={typed} />}
    </div>
  );
}

/** A labelled block; labels number themselves "// 01 — label" through a CSS counter, kept out of the heading's spoken name. */
function Section({ label, index = 0, children }: { label: string; index?: number; children: ReactNode }) {
  return (
    <section className="sec" style={{ ["--i" as string]: Math.min(index, 8) }}>
      <h2 className="section-title">
        <span className="sec-no" aria-hidden />
        {label}
      </h2>
      {children}
    </section>
  );
}

/** `tap`: the card is one big tap target (a stretched link inside it), so it presses and catches the glare. */
function Card({ children, tap = false, className, index = 0 }: { children: ReactNode; tap?: boolean; className?: string; index?: number }) {
  const glare = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    event.currentTarget.style.setProperty("--mx", `${event.clientX - rect.left}px`);
    event.currentTarget.style.setProperty("--my", `${event.clientY - rect.top}px`);
  };
  return (
    <div className={cx("card", tap && "tap", className)} style={{ ["--i" as string]: Math.min(index, 8) }} {...(tap ? { onPointerDown: glare, onPointerMove: glare } : {})}>
      {children}
    </div>
  );
}

/** The initial stays underneath: it shows while the photo loads and whenever there is none. */
function Avatar({ name, src, size = "md" }: { name: string; src?: string | null; size?: "sm" | "md" | "big" }) {
  const [failed, setFailed] = useState<string | null>(null);
  const photo = src && src !== failed ? src : null;
  return (
    <div className={cx("avatar", size !== "md" && size)} aria-hidden>
      {Array.from(name.trim())[0]?.toUpperCase() ?? "?"}
      {photo && <img src={photo} alt="" loading="lazy" decoding="async" onError={() => setFailed(photo)} />}
    </div>
  );
}

/** Status codes from the API, with the words and tones people see. */
const STATUS_META: Record<string, { label: string; tone: string; key: string }> = {
  idea: { label: "idea", tone: "var(--tg)", key: "idea" },
  in_progress: { label: "in progress", tone: "var(--neon-ink)", key: "progress" },
  launched: { label: "launched", tone: "var(--green)", key: "launched" },
  paused: { label: "paused", tone: "var(--muted)", key: "paused" },
  abandoned: { label: "abandoned", tone: "var(--meta)", key: "abandoned" },
};

function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status];
  return (
    <span className={`badge s-${meta?.key ?? "other"}`} style={{ ["--tone" as string]: meta?.tone ?? "var(--muted)" }}>
      {meta?.label ?? status}
    </span>
  );
}

/** The score in a honeycomb cell that fills with honey relative to the leader. */
function HexScore({ score, max, big = false, lead = false }: { score: number; max: number; big?: boolean; lead?: boolean }) {
  // Any score shows at least a drop of honey; nothing at all stays an empty cell.
  const percent = score > 0 && max > 0 ? Math.max(8, Math.round((score / max) * 100)) : 0;
  return (
    <div className={cx("hex-score", big && "big", lead && "lead")} style={{ ["--p" as string]: percent }} role="img" aria-label={`Score ${score}`}>
      <b aria-hidden>{score}</b>
    </div>
  );
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (value: T) => void }) {
  const index = Math.max(0, options.findIndex(([key]) => key === value));
  return (
    <div className="segmented" role="group" aria-label={label}>
      <div className="pill" aria-hidden style={{ width: `calc((100% - 6px) / ${options.length})`, transform: `translateX(${index * 100}%)` }} />
      {options.map(([key, label]) => (
        <button
          key={key}
          className={key === value ? "active" : undefined}
          aria-pressed={key === value}
          onClick={() => {
            if (key === value) return;
            haptic("select");
            onChange(key);
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Stat({ value, label }: { value: ReactNode; label: string }) {
  return (
    <div className="stat">
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

function ExternalLink({ href, children, className, icon }: { href: string; children: ReactNode; className?: string; icon?: IconName }) {
  return (
    <a
      href={href}
      className={cx("go", href.startsWith("https://t.me/") && "tg", className)}
      onClick={(event) => {
        event.preventDefault();
        haptic();
        openTelegram(href);
      }}
    >
      {icon && <Icon name={icon} />}
      <span className="go-text">{children}</span>
    </a>
  );
}

function SourceLink({ url }: { url: string }) {
  return (
    <a
      className="source"
      href={url}
      aria-label="Open the source message"
      onClick={(event) => {
        event.preventDefault();
        haptic();
        openTelegram(url);
      }}
    >
      <Icon name="arrowUpRight" />
    </a>
  );
}

/** A textarea that grows with its text: a hidden mirror of the value sizes the shared grid cell. */
function AutoTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }) {
  return (
    <div className="autosize" data-value={props.value}>
      <textarea className="input" {...props} />
    </div>
  );
}

interface ToastState {
  id: number;
  text: string;
  undo?: () => void;
}

function Toast({ text, undo, onClose }: { text: string; undo?: () => void; onClose: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(onClose, 4000);
    return () => window.clearTimeout(timer);
  }, [text, onClose]);
  return (
    <div className="toast" role="status">
      <span>{text}</span>
      {undo && (
        <button
          onClick={() => {
            undo();
            onClose();
          }}
        >
          Undo
        </button>
      )}
    </div>
  );
}

// ---------- system, empty and loading states ----------

function HiveState({ eyebrow, title, line, action, compact = false }: { eyebrow?: string; title: ReactNode; line: string; action?: ReactNode; compact?: boolean }) {
  return (
    <div className={cx("hive-state", compact && "compact")} role="status">
      <div className="mark">{compact ? <HexMark size={44} muted /> : <HexMark size={72} />}</div>
      {eyebrow && <Eyebrow text={eyebrow} />}
      {compact ? <h2 className="title">{title}</h2> : <h1 className="title">{title}</h1>}
      <Terminal text={line} />
      {action && <div className="hive-action">{action}</div>}
    </div>
  );
}

interface StateCopy {
  eyebrow: string;
  title: ReactNode;
  line: string;
  action?: "retry" | "back";
}

const BROKEN: StateCopy = {
  eyebrow: "error",
  title: (
    <>
      Something <span className="accent">broke</span>
    </>
  ),
  line: "try again in a moment",
  action: "retry",
};

const STATES: Record<string, StateCopy> = {
  unauthorized: {
    eyebrow: "access",
    title: (
      <>
        Open in <span className="accent">Telegram</span>
      </>
    ),
    line: "launch it from your chat’s bot",
  },
  not_a_member: {
    eyebrow: "members only",
    title: (
      <>
        Not in this <span className="accent">hive</span>
      </>
    ),
    line: "cards are for members of the chat",
  },
  choose_chat: {
    eyebrow: "pick a chat",
    title: (
      <>
        Which <span className="accent">hive</span>?
      </>
    ),
    line: "you’re in several chats · pick one above",
  },
  network: {
    eyebrow: "offline",
    title: (
      <>
        Signal <span className="accent">lost</span>
      </>
    ),
    line: "can’t reach the hive",
    action: "retry",
  },
  not_found: {
    eyebrow: "404",
    title: (
      <>
        Nothing <span className="accent">here</span>
      </>
    ),
    line: "this page isn’t in this chat",
    action: "back",
  },
};

type SkeletonKind = "rows" | "board" | "cards" | "person" | "project";

function Skeleton({ kind }: { kind: SkeletonKind }) {
  if (kind === "rows" || kind === "board") {
    return (
      <div className="card board" role="status" aria-label="Loading">
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <div key={index} className="board-row sk-row" style={{ opacity: 1 - index * 0.12 }}>
            {kind === "rows" ? <span className="sk sk-av" /> : <span className="sk sk-rank" />}
            <div className="grow">
              <span className="sk sk-line w60" />
              <span className="sk sk-line w85" />
            </div>
            {kind === "board" && <span className="sk sk-hex" />}
          </div>
        ))}
      </div>
    );
  }
  const lines = (
    <>
      <span className="sk sk-line w40" />
      <span className="sk sk-line w85" />
      <span className="sk sk-line w85" />
      <span className="sk sk-line w60" />
    </>
  );
  if (kind === "person" || kind === "project") {
    // Each hero keeps its own silhouette: a person leads with the avatar, a project with its name and score cell.
    return (
      <div role="status" aria-label="Loading">
        <div className="card hero">
          {kind === "person" ? (
            <div className="row">
              <span className="sk sk-big" />
              <div className="grow">
                <span className="sk sk-line w60" />
                <span className="sk sk-line w40" />
              </div>
            </div>
          ) : (
            <div className="hero-top">
              <div className="grow">
                <span className="sk sk-line sk-name w60" />
                <span className="sk sk-badge" />
              </div>
              <span className="sk sk-hex big" />
            </div>
          )}
          <div className="chips">
            <span className="sk sk-chip" />
            <span className="sk sk-chip" />
            <span className="sk sk-chip" />
          </div>
        </div>
        {[1, 2].map((index) => (
          <div key={index} className="card" style={{ ["--i" as string]: index, opacity: 1 - index * 0.2 }}>
            {lines}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div role="status" aria-label="Loading">
      {[0, 1, 2].map((index) => (
        <div key={index} className="card" style={{ ["--i" as string]: index, opacity: 1 - index * 0.2 }}>
          {lines}
        </div>
      ))}
    </div>
  );
}

/** What a screen shows instead of (or over) its data: a skeleton, a hive state, or a quiet line over stale data. */
function LoadState({ error, retry, skeleton, hasData = false }: { error: string | null; retry: () => void; skeleton: SkeletonKind; hasData?: boolean }) {
  const retryButton = (
    <button className="chip-btn" onClick={retry}>
      <Icon name="retry" />
      Try again
    </button>
  );
  if (error && hasData) {
    return (
      <div className="inline-error" role="alert">
        <span>
          <Glyph>&gt;</Glyph>signal lost
        </span>
        {retryButton}
      </div>
    );
  }
  if (!error) return <Skeleton kind={skeleton} />;
  const copy = STATES[error] ?? BROKEN;
  const action =
    copy.action === "retry" ? (
      retryButton
    ) : copy.action === "back" ? (
      <button className="chip-btn" onClick={goUp}>
        <Icon name="back" />
        Go back
      </button>
    ) : undefined;
  return <HiveState eyebrow={copy.eyebrow} title={copy.title} line={copy.line} action={action} />;
}

// ---------- rows ----------

function PersonRow({ person, onOpen }: { person: PersonSummary; onOpen: () => void }) {
  const solo = !person.tagline && person.top_facts.length === 0;
  return (
    <div className={cx("board-row", solo && "solo")} {...pressable(onOpen)}>
      <Avatar name={person.display_name} src={person.avatar_url} />
      <div className="board-meta">
        <div className="person-top">
          <span className="name ellipsis" lang={langOf(person.display_name)}>
            {person.display_name}
          </span>
          {person.project_count > 0 && (
            <span className="proj-count" role="img" aria-label={plural(person.project_count, "project", "projects")}>
              <Icon name="hex" />
              {person.project_count}
            </span>
          )}
        </div>
        {person.tagline && (
          <div className="hint clamp2" lang={langOf(person.tagline)}>
            {person.tagline}
          </div>
        )}
        {person.top_facts.length > 0 && (
          // The chronicler's three most certain facts, shortest first: the one line keeps whole chips, and a long one
          // (usually the role, which the tagline above already says) must not push the short ones off the line.
          <div className="chips one-line">
            {person.top_facts
              .slice(0, 3)
              .sort((a, b) => a.length - b.length)
              .map((fact, index) => (
                <span key={`${index}:${fact}`} className="chip" lang={langOf(fact)}>
                  {fact}
                </span>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ProjectRow({ project, rank, lead = false, maxScore, showAuthors = true, onOpen }: { project: Project; rank?: number; lead?: boolean; maxScore?: number; showAuthors?: boolean; onOpen: () => void }) {
  return (
    <div className={cx("board-row", lead && "lead")} {...pressable(onOpen)}>
      {rank !== undefined && <span className="rank">{rank}</span>}
      <div className="board-meta">
        <div className="name clamp2" lang={langOf(project.name)}>
          {project.name}
        </div>
        {project.tagline && (
          <div className="hint clamp2" lang={langOf(project.tagline)}>
            {project.tagline}
          </div>
        )}
        <div className="board-sub">
          <StatusBadge status={project.status} />
          {showAuthors && project.authors.length > 0 && <span className="ellipsis">{project.authors.map((author) => author.display_name).join(" · ")}</span>}
        </div>
      </div>
      {maxScore !== undefined && <HexScore score={project.score} max={maxScore} lead={lead} />}
    </div>
  );
}

// ---------- people ----------

function PeopleScreen({ go }: { go: Go }) {
  const { data, error, reload } = useLoad<{ people: PersonSummary[] }>("/people");
  if (!data && error) return <LoadState error={error} retry={reload} skeleton="rows" />;
  const people = data?.people ?? [];
  const withProjects = people.filter((person) => person.project_count > 0).length;
  const members = plural(people.length, "member", "members");
  return (
    <>
      <Title eyebrow="members" terminal={!data ? "loading the hive" : withProjects > 0 ? `${members} · ${withProjects} with projects` : members}>
        The <span className="accent">hive</span>
      </Title>
      {(!data || error) && <LoadState error={error} retry={reload} skeleton="rows" hasData={data !== null} />}
      {people.length > 0 && (
        <Card className="board" index={3}>
          {people.map((person) => (
            <PersonRow key={person.id} person={person} onOpen={() => go(`/u/${person.id}`)} />
          ))}
        </Card>
      )}
      {data && people.length <= 2 && (
        <div className="footnote">
          <Glyph>&gt;</Glyph>cards fill in as people talk in the chat
        </div>
      )}
    </>
  );
}

/** Short values read better as tags than as rows. */
const CHIP_KINDS = new Set(["stack", "interest", "timezone"]);
const KIND_ORDER = ["role", "stack", "expertise", "can_help", "looking_for", "interest", "link", "timezone", "project"];

function groupFacts(facts: Fact[]): [string, Fact[]][] {
  const groups = new Map<string, Fact[]>();
  for (const fact of facts) groups.set(fact.kind, [...(groups.get(fact.kind) ?? []), fact]);
  const rank = (kind: string) => {
    const index = KIND_ORDER.indexOf(kind);
    return index === -1 ? KIND_ORDER.length : index;
  };
  return [...groups.entries()].sort(([a], [b]) => rank(a) - rank(b));
}

interface PersonResponse {
  person: PersonSummary;
  facts: Fact[];
  /** What the chat calls them, set by them, an owner or the chronicler. */
  aliases?: string[];
  projects: Project[];
  memos?: Memo[];
  messages_30d: number;
  is_me?: boolean;
  /** The viewer's own card, or a bot owner looking after someone else's. */
  can_edit: boolean;
}

function PersonScreen({ id, go }: { id: string; go: Go }) {
  const { data, error, reload } = useLoad<PersonResponse>(`/people/${id}`);
  const [moderating, setModerating] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const closeToast = useCallback(() => setToast(null), []);
  if (!data) return <LoadState error={error} retry={reload} skeleton="person" />;
  const { person, facts, projects } = data;
  // A bot owner hides a wrong fact on someone else's card the way people hide their own: reversibly.
  const factAction = async (fact: Fact, action: "hide" | "restore") => {
    setBusy(fact.id);
    try {
      await api(`/facts/${fact.id}/${action}`, { method: "POST", body: {} });
      haptic("success");
      reload();
      if (action === "hide") setToast({ id: Date.now(), text: "Hidden", undo: () => void factAction(fact, "restore") });
    } catch {
      haptic("error");
      setToast({ id: Date.now(), text: "Couldn’t update — try again" });
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      {error && <LoadState error={error} retry={reload} skeleton="person" hasData />}
      <Card className="hero">
        <div className="row">
          <Avatar name={person.display_name} src={person.avatar_url} size="big" />
          <div className="grow">
            <h1 className="hero-name" lang={langOf(person.display_name)}>
              {person.display_name}
            </h1>
            {person.username && (
              <ExternalLink href={`https://t.me/${person.username}`} className="handle">
                @{person.username}
              </ExternalLink>
            )}
          </div>
        </div>
        {data.aliases && data.aliases.length > 0 && (
          <p className="hero-aliases" lang={langOf(data.aliases.join(" "))}>
            Known here as {data.aliases.join(", ")}
          </p>
        )}
        {person.tagline && (
          <p className="hero-text" lang={langOf(person.tagline)}>
            {person.tagline}
          </p>
        )}
        <div className="stats">
          <Stat value={data.messages_30d} label="msgs · 30d" />
          <Stat value={projects.length} label={projects.length === 1 ? "project" : "projects"} />
          <Stat value={facts.length} label={facts.length === 1 ? "fact" : "facts"} />
        </div>
        {data.is_me ? (
          <button className="btn outline small hero-edit" onClick={() => go("/me")}>
            <Icon name="pen" />
            Edit my card
          </button>
        ) : (
          data.can_edit && (
            <button className="btn outline small hero-edit" aria-expanded={moderating} onClick={() => setModerating(!moderating)}>
              <Icon name={moderating ? "check" : "pen"} />
              {moderating ? "Done" : "Edit card"}
            </button>
          )
        )}
      </Card>
      <Section label="facts" index={1}>
        <Card className="dossier">
          {moderating && !data.is_me && facts.length > 0 ? (
            <FactGroups
              facts={facts}
              actions={(fact) => (
                <button className="icon-btn" aria-label={`Hide “${fact.value}”`} disabled={busy === fact.id} onClick={() => void factAction(fact, "hide")}>
                  <Icon name="eyeOff" />
                </button>
              )}
            />
          ) : person.opted_out ? (
            <div className="hint">Asked not to collect anything about them.</div>
          ) : facts.length === 0 ? (
            <div className="hint">The chronicler hasn’t noted anything about {person.display_name} yet.</div>
          ) : (
            groupFacts(facts).map(([kind, items]) => {
              const chips = CHIP_KINDS.has(kind) ? items.filter((fact) => fact.value.length <= 28) : [];
              const rows = items.filter((fact) => !chips.includes(fact));
              return (
                <div key={kind} className="dossier-row">
                  <div className="kind">{FACT_LABELS[kind] ?? kind}</div>
                  {chips.length > 0 && (
                    <div className="chips">
                      {chips.map((fact) => (
                        <span key={fact.id} className={cx("chip big", kind === "stack" && "code")} lang={langOf(fact.value)}>
                          {fact.value}
                        </span>
                      ))}
                    </div>
                  )}
                  {rows.map((fact) => {
                    const href = kind === "link" ? openableUrl(fact.value) : null;
                    return (
                      <div key={fact.id} className="fact-line">
                        <div className="grow" lang={langOf(fact.value)}>
                          {href ? (
                            <ExternalLink href={href} icon={linkIcon(href)}>
                              {prettyUrl(fact.value)}
                            </ExternalLink>
                          ) : (
                            fact.value
                          )}
                        </div>
                        {fact.sources[0] && <SourceLink url={fact.sources[0].url} />}
                      </div>
                    );
                  })}
                </div>
              );
            })
          )}
        </Card>
      </Section>
      {data.memos && data.memos.length > 0 && (
        <Section label="notes" index={2}>
          <Card className="dossier">
            <NoteList
              memos={data.memos}
              canDelete={() => data.can_edit}
              busy={busy}
              onDelete={async (memo) => {
                setBusy(memo.id);
                if (await deleteNote(memo)) reload();
                setBusy(null);
              }}
            />
          </Card>
        </Section>
      )}
      {projects.length > 0 && (
        <Section label="projects" index={2}>
          <Card className="board">
            {projects.map((project) => (
              <ProjectRow key={project.id} project={project} showAuthors={false} onOpen={() => go(`/p/${project.slug}`)} />
            ))}
          </Card>
        </Section>
      )}
      {toast && <Toast key={toast.id} text={toast.text} undo={toast.undo} onClose={closeToast} />}
    </>
  );
}

// ---------- rating ----------

const SORTS = ["top", "alive", "new"] as const;
type Sort = (typeof SORTS)[number];

const EXPLAINER: [string, string][] = [
  ["An AI reads the chat.", "Every few hours the chronicler goes through new messages."],
  ["Real signals count.", "Feedback, who uses what, who helps, how a project grows."],
  ["Votes count too.", "Members can vote for any project except their own."],
  ["Fresh beats old.", "Recent signals weigh more, and repeating a name won’t pump the score."],
];

function ProjectsScreen({ go, startAdding }: { go: Go; startAdding: boolean }) {
  const [sort, setSort] = useRemembered<Sort>("rating.sort", "top");
  const { data, error, reload, pending, dataPath } = useLoad<{ projects: Project[] }>(`/projects?sort=${sort}`);
  const [adding, setAdding] = useState(startAdding);
  const [showHelp, setShowHelp] = useRemembered("rating.help", false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // The ?add flag only opens the form once; Back must not reopen it. The entry keeps its in-app stamp.
    if (startAdding) window.history.replaceState(window.history.state, "", "#/projects");
  }, [startAdding]);

  useEffect(() => {
    if (!adding) return;
    nameRef.current?.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
    nameRef.current?.focus({ preventScroll: true });
  }, [adding]);

  if (!data && error) return <LoadState error={error} retry={reload} skeleton="board" />;
  const dataSort = SORTS.find((candidate) => dataPath?.endsWith(`sort=${candidate}`)) ?? sort;
  const projects = data?.projects ?? [];
  const maxScore = Math.max(1, ...projects.map((project) => project.score));
  const count = plural(projects.length, "project", "projects");
  // A failed re-sort keeps the old list usable (not dimmed): the line above it says the signal was lost.
  const ranking = pending && !error;
  const empty = data !== null && projects.length === 0;
  const terminal = !data
    ? "counting honey"
    : ranking
      ? "re-ranking…"
      : empty
        ? "nothing to rank yet"
        : dataSort === "top"
          ? `the chronicler ranked ${count}`
          : dataSort === "alive"
            ? `${count} · most active first`
            : `${count} · newest first`;

  return (
    <>
      <Title
        eyebrow="rating"
        terminal={terminal}
        pending={ranking}
        action={
          <button
            className="chip-btn accent"
            aria-expanded={adding}
            onClick={() => {
              haptic();
              setAdding((value) => !value);
            }}
          >
            <Icon name={adding ? "close" : "plus"} />
            {adding ? "Close" : "Add"}
          </button>
        }
      >
        Chat <span className="accent">projects</span>
      </Title>
      {adding && (
        <ProjectForm
          nameRef={nameRef}
          onCancel={() => setAdding(false)}
          onOpen={(slug) => {
            setAdding(false);
            reload();
            go(`/p/${slug}`);
          }}
        />
      )}
      {!empty && <Segmented label="Sort" value={sort} options={[["top", "Top"], ["alive", "Active"], ["new", "New"]]} onChange={setSort} />}
      {projects.length > 0 && (
        <button
          className="disclosure"
          aria-expanded={showHelp}
          onClick={() => {
            haptic("select");
            setShowHelp(!showHelp);
          }}
        >
          <Glyph>&gt;</Glyph>
          how the score works
          <Icon name="chevron" />
        </button>
      )}
      {showHelp && projects.length > 0 && (
        <Card className="explain">
          <ul className="showcase-list">
            {EXPLAINER.map(([lead, text]) => (
              <li key={lead}>
                <Icon name="check" />
                <span>
                  <b>{lead}</b> {text}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {(!data || error) && <LoadState error={error} retry={reload} skeleton="board" hasData={data !== null} />}
      {empty && (
        <HiveState
          compact
          title={
            <>
              No projects <span className="accent">yet</span>
            </>
          }
          line="add one, or just mention it in the chat"
          action={
            !adding && (
              <button className="btn" onClick={() => setAdding(true)}>
                <Icon name="plus" />
                Add the first project
              </button>
            )
          }
        />
      )}
      {projects.length > 0 && (
        <div className={cx(ranking && "stale")}>
          <Card className="board" key={dataPath ?? undefined} index={5}>
            {projects.map((project, index) => (
              <ProjectRow
                key={project.id}
                project={project}
                rank={dataSort === "top" ? index + 1 : undefined}
                lead={dataSort === "top" && index === 0}
                maxScore={maxScore}
                onOpen={() => go(`/p/${project.slug}`)}
              />
            ))}
          </Card>
        </div>
      )}
    </>
  );
}

function ProjectForm({ nameRef, onOpen, onCancel }: { nameRef: RefObject<HTMLInputElement | null>; onOpen: (slug: string) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [tagline, setTagline] = useState("");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  // `slug`: the form clashed with a project already in the catalog, which can be opened instead.
  const [failure, setFailure] = useState<{ text: string; slug?: string } | null>(null);
  const submit = async () => {
    setBusy(true);
    setFailure(null);
    const url = withScheme(link.trim());
    const isRepo = /github\.com|gitlab\.com|codeberg\.org/.test(url);
    try {
      const result = await api<{ slug: string }>("/projects", {
        method: "POST",
        body: { name: name.trim(), tagline: tagline.trim() || null, repo: isRepo ? url : null, site: !isRepo && url ? url : null },
      });
      haptic("success");
      onOpen(result.slug);
    } catch (err) {
      haptic("error");
      setBusy(false);
      const clash = err instanceof ApiError && err.code === "exists" && typeof err.details.slug === "string" ? err.details.slug : undefined;
      // Name and one-liner are capped to the server's limits, so a rejected form means the link didn't parse.
      if (clash) setFailure({ text: "it’s already in the catalog", slug: clash });
      else setFailure({ text: err instanceof ApiError && err.code === "bad_request" && url ? "couldn’t add it — check the link (https://…)" : "couldn’t add it — try again" });
    }
  };
  const existing = failure?.slug;
  return (
    <Card className="form">
      <label className="field">
        <span className="field-label">Name</span>
        <input ref={nameRef} className="input" placeholder="e.g. Waggle" maxLength={80} value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">One-liner</span>
        <input className="input" placeholder="What it is, in one line" maxLength={200} value={tagline} onChange={(event) => setTagline(event.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">Link</span>
        <input className="input" placeholder="https://github.com/… or a website" {...URL_INPUT} value={link} onChange={(event) => setLink(event.target.value)} />
      </label>
      <div className="form-actions">
        <button className="btn" disabled={!name.trim() || busy} onClick={() => void submit()}>
          {busy ? "Adding…" : "Add project"}
        </button>
        <button className="btn outline" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {failure && (
        <div className={cx("form-error", existing && "with-action")} role="alert">
          <span>
            <Glyph>&gt;</Glyph>
            {failure.text}
          </span>
          {existing && (
            <button className="chip-btn" onClick={() => onOpen(existing)}>
              <Icon name="arrowUpRight" />
              Open it
            </button>
          )}
        </div>
      )}
    </Card>
  );
}

// ---------- project ----------

const SIGNAL_META: Record<string, { label: string; icon: IconName; tone: string; soft: string }> = {
  praise: { label: "praise", icon: "heart", tone: "var(--neon-ink)", soft: "var(--neon-soft)" },
  milestone: { label: "milestone", icon: "bolt", tone: "var(--neon-ink)", soft: "var(--neon-soft)" },
  usage: { label: "usage", icon: "check", tone: "var(--green)", soft: "var(--green-soft)" },
  contribution: { label: "contribution", icon: "users", tone: "var(--green)", soft: "var(--green-soft)" },
  interest: { label: "interest", icon: "eye", tone: "var(--tg)", soft: "var(--tg-soft)" },
  critique: { label: "critique", icon: "message", tone: "var(--tg)", soft: "var(--tg-soft)" },
};

type EditFace = "edit" | "done" | "cancel";

const EDIT_TOGGLE: { face: EditFace; icon: IconName; label: string }[] = [
  { face: "edit", icon: "pen", label: "Edit" },
  { face: "done", icon: "check", label: "Done" },
  { face: "cancel", icon: "close", label: "Cancel" },
];

/** Honey hexes spark just off the button's edge and fly outward. */
function burstFrom(element: HTMLElement) {
  if (reducedMotion()) return;
  const rect = element.getBoundingClientRect();
  const cx0 = rect.left + rect.width / 2;
  const cy0 = rect.top + rect.height / 2;
  const halfW = rect.width / 2 + 4;
  const halfH = rect.height / 2 + 4;
  for (let index = 0; index < 8; index += 1) {
    const angle = (Math.PI * 2 * index) / 8 - Math.PI / 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    // Distance to the edge of the (padded) button rectangle along this direction.
    const reach = Math.min(Math.abs(cos) > 1e-6 ? halfW / Math.abs(cos) : Infinity, Math.abs(sin) > 1e-6 ? halfH / Math.abs(sin) : Infinity);
    const spark = document.createElement("div");
    spark.className = "burst";
    spark.style.left = `${cx0 + reach * cos - 5}px`;
    spark.style.top = `${cy0 + reach * sin - 5.5}px`;
    spark.style.setProperty("--dx", `${26 * cos}px`);
    spark.style.setProperty("--dy", `${26 * sin}px`);
    spark.style.setProperty("--rot", `${(index % 2 ? 1 : -1) * 40}deg`);
    document.body.appendChild(spark);
    window.setTimeout(() => spark.remove(), 800);
  }
}

interface ProjectResponse {
  project: Project;
  can_edit: boolean;
  first_seen_url: string | null;
  discussions: { msg_id: number; text: string; display_name: string | null; url: string }[];
  history: ChronicleEntry[];
  memos?: Memo[];
  /** The viewer is one of its authors. */
  can_note?: boolean;
  /** A bot owner, who may take a note down. */
  can_moderate?: boolean;
}

function ProjectScreen({ slug, go }: { slug: string; go: Go }) {
  const { data, error, reload } = useLoad<ProjectResponse>(`/projects/${slug}`);
  // Whether this is the viewer's own project (authors can't vote for it) comes from their card, asked once.
  const viewer = useLoad<MeResponse>("/me", { once: true });
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [result, setResult] = useState<{ voted: boolean; votes: number } | null>(null);
  const [refused, setRefused] = useState(false);
  const [pop, setPop] = useState(false);
  const [allHistory, setAllHistory] = useState(false);
  const [noteBusy, setNoteBusy] = useState<number | null>(null);
  useEffect(() => setResult(null), [data]);
  // The viewer is awaited too, so an author never meets a Vote button that can only fail.
  if (!data || (!viewer.data && !viewer.error)) return <LoadState error={error} retry={reload} skeleton="project" />;

  const { project, history, discussions } = data;
  const own = refused || project.authors.some((author) => author.id === viewer.data?.user.id);
  const links = [...new Set([project.links.repo, project.links.site, ...(project.links.other ?? [])].filter((link): link is string => Boolean(link)).map(withScheme))];
  const voted = result?.voted ?? project.voted_by_me;
  const votes = result?.votes ?? project.votes;
  const toggleFace: EditFace = !editing ? "edit" : dirty ? "cancel" : "done";
  const vote = async (event: MouseEvent<HTMLButtonElement>) => {
    const button = event.currentTarget;
    const next = !voted;
    haptic();
    setPop(true);
    try {
      await api(`/projects/${project.id}/vote`, { method: "POST", body: { voted: next } });
      haptic("success");
      if (next) burstFrom(button);
      setResult({ voted: next, votes: Math.max(0, votes + (next ? 1 : -1)) });
      reload();
    } catch (err) {
      haptic("error");
      if (err instanceof ApiError && err.code === "own_project") {
        setRefused(true);
        tgAlert("Authors can’t vote for their own project.");
      }
    }
  };
  const voteButton = own ? (
    <button className="btn outline" disabled>
      <Icon name="vote" />
      Your project · <span className="vote-count">{votes}</span>
    </button>
  ) : (
    <button
      className={cx("btn cta", voted && "ghost", pop && "pop")}
      aria-pressed={voted}
      onClick={(event) => void vote(event)}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) setPop(false);
      }}
    >
      <Icon name={voted ? "check" : "vote"} />
      {voted ? "Voted" : "Vote"} ·{" "}
      <span className="vote-count" key={votes}>
        {votes}
      </span>
    </button>
  );

  return (
    <>
      {error && <LoadState error={error} retry={reload} skeleton="project" hasData />}
      <Card className="hero">
        <div className="hero-top">
          <div className="grow">
            <h1 className="hero-name" lang={langOf(project.name)}>
              {project.name}
            </h1>
            <StatusBadge status={project.status} />
          </div>
          <div className="score-block">
            <HexScore score={project.score} max={Math.max(project.score, 30)} big />
            <span className="hex-cap">score</span>
          </div>
        </div>
        {project.tagline && (
          <p className="hero-text" lang={langOf(project.tagline)}>
            {project.tagline}
          </p>
        )}
        {project.stack.length > 0 && (
          <div className="chips">
            {project.stack.map((item, index) => (
              <span key={`${index}:${item}`} className="chip code">
                {item}
              </span>
            ))}
          </div>
        )}
        {links.length > 0 && (
          <div className="links">
            {links.map((link) => (
              <ExternalLink key={link} href={link} icon={linkIcon(link)}>
                {prettyUrl(link)}
              </ExternalLink>
            ))}
          </div>
        )}
        <div className="stats">
          <Stat value={project.signals_count ?? project.recent_signals.length} label="signals" />
          <Stat value={project.last_activity_at ? new Date(project.last_activity_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "—"} label="active" />
          <Stat value={project.authors.length} label={project.authors.length === 1 ? "author" : "authors"} />
        </div>
        <div className="hero-actions">
          {voteButton}
          {data.can_edit && (
            // With unsaved changes the toggle says what it does: Cancel drops them, Done only closes.
            // All three faces share one grid cell, so the button keeps the width of the widest and the row never reflows.
            <button className="btn outline swap" aria-expanded={editing} onClick={() => setEditing(!editing)}>
              {EDIT_TOGGLE.map(({ face, icon, label }) => (
                <span key={face} className={cx(face !== toggleFace && "off")}>
                  <Icon name={icon} />
                  {label}
                </span>
              ))}
            </button>
          )}
        </div>
      </Card>
      {editing && (
        <ProjectEditor
          project={project}
          viewer={viewer.data ? { id: viewer.data.user.id, isOwner: viewer.data.user.is_admin === true } : null}
          onDirty={setDirty}
          onSaved={() => {
            // A new name shows up in every list, so none is reused from the cache.
            cache.clear();
            reload();
          }}
          onDeleted={() => {
            // Every cached list may still carry the project; screens reload instead of flashing it.
            cache.clear();
            goUp();
          }}
          onMerged={(slug) => {
            // The duplicate is gone: its screen gives way to the project it joined.
            cache.clear();
            window.location.replace(`#/p/${slug}`);
          }}
        />
      )}
      {project.authors.length > 0 && (
        <Section label="authors" index={1}>
          <Card className="board">
            {project.authors.map((author) => (
              <div key={author.id} className="board-row author-row" {...pressable(() => go(`/u/${author.id}`))}>
                <Avatar name={author.display_name} src={author.avatar_url} size="sm" />
                <div className="board-meta">
                  <span className="name ellipsis" lang={langOf(author.display_name)}>
                    {author.display_name}
                  </span>
                  {author.role && (
                    <span className="hint ellipsis" lang={langOf(author.role)}>
                      {author.role}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </Card>
        </Section>
      )}
      {((data.memos ?? []).length > 0 || data.can_note) && (
        <Section label="notes" index={2}>
          <Card className="dossier">
            {(data.memos ?? []).length === 0 ? (
              <div className="hint">Nothing yet — news, plans, what the project needs.</div>
            ) : (
              <NoteList
                memos={data.memos ?? []}
                canDelete={(memo) => memo.user_id === viewer.data?.user.id || Boolean(data.can_moderate)}
                busy={noteBusy}
                byline={(memo) => memo.display_name ?? null}
                onDelete={async (memo) => {
                  setNoteBusy(memo.id);
                  if (await deleteNote(memo)) reload();
                  setNoteBusy(null);
                }}
              />
            )}
            {data.can_note && <NoteForm projectId={project.id} placeholder="A note on the project, in your own words" onAdded={reload} />}
          </Card>
        </Section>
      )}
      {project.recent_signals.length > 0 && (
        <Section label="recent signals" index={2}>
          <Card>
            {project.recent_signals.map((signal, index) => {
              const meta = SIGNAL_META[signal.kind] ?? { label: signal.kind, icon: "message", tone: "var(--muted)", soft: "var(--surface-2)" };
              return (
                <div key={index} className="signal" style={{ ["--tone" as string]: meta.tone, ["--tone-soft" as string]: meta.soft }}>
                  <span className="signal-icon">
                    <Icon name={meta.icon} />
                  </span>
                  <div className="grow">
                    <div className="signal-kind">{meta.label}</div>
                    <div className="signal-note" lang={langOf(signal.note)}>
                      {signal.note}
                    </div>
                  </div>
                </div>
              );
            })}
          </Card>
        </Section>
      )}
      {history.length > 0 && (
        <Section label="history" index={3}>
          <ChronicleList entries={allHistory ? history : history.slice(0, 3)} compact />
          {history.length > 3 && !allHistory && (
            <button className="chip-btn history-more" onClick={() => setAllHistory(true)}>
              Show all {history.length}
            </button>
          )}
        </Section>
      )}
      {discussions.length > 0 && (
        <div className="coach sec" style={{ ["--i" as string]: 4 }}>
          <div className="coach-head">
            <span className="coach-dot" aria-hidden />
            <h2 className="coach-name">In the chat</h2>
            <span className="coach-status">{plural(discussions.length, "message", "messages")} · tap to open</span>
          </div>
          <div className="coach-log">
            {discussions.map((row) => (
              <button
                key={row.msg_id}
                className="coach-bubble"
                onClick={() => {
                  haptic();
                  openTelegram(row.url);
                }}
              >
                <span className="who" lang={langOf(row.display_name)}>
                  {row.display_name ?? "someone"}
                </span>
                <span className="txt" lang={langOf(row.text)}>
                  {row.text}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

interface ProjectEditorProps {
  project: Project;
  viewer: { id: number; isOwner: boolean } | null;
  onDirty: (dirty: boolean) => void;
  onSaved: () => void;
  onDeleted: () => void;
  onMerged: (slug: string) => void;
}

function ProjectEditor({ project, viewer, onDirty, onSaved, onDeleted, onMerged }: ProjectEditorProps) {
  const [name, setName] = useState(project.name);
  const [tagline, setTagline] = useState(project.tagline ?? "");
  const [status, setStatus] = useState(project.status);
  const [stack, setStack] = useState(project.stack.join(", "));
  const [repo, setRepo] = useState(project.links.repo ?? "");
  const [site, setSite] = useState(project.links.site ?? "");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // A duplicate can be folded only into a project the viewer also authors; a bot owner may fold any.
  const catalog = useLoad<{ projects: Project[] }>("/projects?sort=new", { once: true });
  const [mergeInto, setMergeInto] = useState("");
  const [merging, setMerging] = useState(false);
  const mergeTargets = (catalog.data?.projects ?? [])
    .filter((other) => other.id !== project.id && (viewer?.isOwner || other.authors.some((author) => author.id === viewer?.id)))
    .sort((a, b) => a.name.localeCompare(b.name));

  const stackItems = stack
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const changes = { name: name.trim(), tagline: tagline.trim() || null, status, stack: stackItems, repo: withScheme(repo.trim()) || null, site: withScheme(site.trim()) || null };
  // Dirty means "differs from what was last saved", compared in the form it is sent.
  const snapshot = JSON.stringify(changes);
  const [clean, setClean] = useState(snapshot);
  const dirty = snapshot !== clean;
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);

  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), 2000);
    return () => window.clearTimeout(timer);
  }, [saved]);

  const save = async () => {
    setBusy(true);
    setFailure(null);
    // The name goes along only when it changed: a rename is recorded in the project's history.
    const { name: newName, ...fields } = changes;
    try {
      await api(`/projects/${project.id}`, { method: "PATCH", body: newName === project.name ? fields : changes });
      haptic("success");
      setClean(snapshot);
      setSaved(true);
      onSaved();
    } catch (err) {
      haptic("error");
      // Name and description are capped by maxLength and the status comes from the chips: a rejection is the stack or a link.
      const rejected = err instanceof ApiError && err.code === "bad_request";
      const stackTooBig = stackItems.length > 20 || stackItems.some((item) => item.length > 40);
      setFailure(
        err instanceof ApiError && err.code === "name_taken"
          ? `not saved — another project is already called “${newName}”; if it is the same one, pick it under “A duplicate of”`
          : !rejected
            ? "not saved — try again"
            : stackTooBig
              ? "not saved — up to 20 stack items, 40 characters each"
              : "not saved — check the links (https://…)",
      );
    } finally {
      setBusy(false);
    }
  };
  const merge = async () => {
    const target = mergeTargets.find((other) => other.slug === mergeInto);
    if (!target || merging) return;
    const sure = await tgConfirm(`Merge “${project.name}” into “${target.name}”? Its authors, votes, signals and history move to “${target.name}”, and “${project.name}” leaves the catalog.`);
    if (!sure) return;
    setMerging(true);
    setFailure(null);
    try {
      const { slug } = await api<{ ok: boolean; slug: string }>(`/projects/${project.id}/merge`, { method: "POST", body: { into: target.slug } });
      haptic("success");
      onMerged(slug);
    } catch (err) {
      haptic("error");
      setFailure(err instanceof ApiError && err.code === "forbidden" ? "not merged — only the bot owner or an author of both projects can merge them" : "not merged — try again");
    } finally {
      setMerging(false);
    }
  };
  const remove = async () => {
    if (!(await tgConfirm(`Remove “${project.name}” from the catalog?`))) return;
    try {
      await api(`/projects/${project.id}`, { method: "DELETE" });
      haptic("success");
      onDeleted();
    } catch {
      haptic("error");
      setFailure("not deleted — try again");
    }
  };

  return (
    <Card className="form">
      <label className="field">
        <span className="field-label">Name</span>
        <input className="input" maxLength={80} autoComplete="off" value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <div className="field">
        <span className="field-label">Status</span>
        <div className="status-picker" role="group" aria-label="Status">
          {STATUSES.map((value) => (
            <button
              key={value}
              className={cx("pick", `s-${STATUS_META[value]?.key}`)}
              style={{ ["--tone" as string]: STATUS_META[value]?.tone }}
              aria-pressed={status === value}
              onClick={() => {
                haptic("select");
                setStatus(value);
              }}
            >
              {status === value && <Icon name="check" />}
              {STATUS_META[value]?.label ?? value}
            </button>
          ))}
        </div>
      </div>
      <label className="field">
        <span className="field-label">Description</span>
        <AutoTextarea rows={3} maxLength={200} placeholder="One or two lines about the project" value={tagline} onChange={(event) => setTagline(event.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">Stack · comma-separated</span>
        <input className="input" placeholder="e.g. TypeScript, Postgres" autoCapitalize="none" value={stack} onChange={(event) => setStack(event.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">Repository</span>
        <input className="input" placeholder="https://github.com/…" {...URL_INPUT} value={repo} onChange={(event) => setRepo(event.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">Website</span>
        <input className="input" placeholder="https://…" {...URL_INPUT} value={site} onChange={(event) => setSite(event.target.value)} />
      </label>
      {mergeTargets.length > 0 && (
        <div className="field">
          <span className="field-label" id={`merge-${project.id}`}>
            A duplicate of
          </span>
          <div className="merge-row">
            <select className="input" aria-labelledby={`merge-${project.id}`} value={mergeInto} onChange={(event) => setMergeInto(event.target.value)}>
              <option value="">Pick a project…</option>
              {mergeTargets.map((other) => (
                <option key={other.slug} value={other.slug}>
                  {other.name}
                </option>
              ))}
            </select>
            <button className="btn outline" disabled={!mergeInto || merging} onClick={() => void merge()}>
              {merging ? "Merging…" : "Merge"}
            </button>
          </div>
        </div>
      )}
      <div className="form-actions">
        <button className="btn" disabled={busy || !dirty || !changes.name} onClick={() => void save()}>
          {busy ? "Saving…" : "Save"}
        </button>
        {saved && (
          <span className="saved" role="status">
            <Icon name="check" />
            saved
          </span>
        )}
        <span className="grow" />
        <button className="btn danger" onClick={() => void remove()}>
          Delete project
        </button>
      </div>
      {failure && (
        <div className="form-error" role="alert">
          <Glyph>&gt;</Glyph>
          {failure}
        </div>
      )}
    </Card>
  );
}

// ---------- chronicle ----------

const KIND_LABEL: Record<ChronicleEntry["kind"], string> = { discussion: "discussion", project: "project", link: "link", news: "news", debate: "debate" };
const KIND_TONE: Record<ChronicleEntry["kind"], string> = {
  project: "var(--neon-ink)",
  discussion: "var(--tg)",
  link: "var(--green)",
  news: "var(--muted)",
  debate: "var(--danger-ink)",
};

function ChronicleCard({ entry, index, compact }: { entry: ChronicleEntry; index: number; compact: boolean }) {
  const url = entry.url;
  const when = new Date(entry.period_to);
  const stamp = compact
    ? when.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
    : when.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return (
    <Card index={index} tap={url !== null} className="entry">
      <div className="entry-head">
        <h3 className="entry-title" lang={langOf(entry.title)}>
          {url ? (
            <a
              className="entry-link"
              href={url}
              onClick={(event) => {
                event.preventDefault();
                haptic();
                openTelegram(url);
              }}
            >
              {entry.title}
            </a>
          ) : (
            entry.title
          )}
        </h3>
        <span className="importance" role="img" aria-label={`Importance ${entry.importance} of 5`}>
          {[1, 2, 3, 4, 5].map((level) => (
            <i key={level} className={level <= entry.importance ? "on" : undefined} />
          ))}
        </span>
      </div>
      <p className={cx("entry-summary", compact && "clamp3")} lang={langOf(entry.summary)}>
        {entry.summary}
      </p>
      <div className="stamp">
        <span className="badge" style={{ ["--tone" as string]: KIND_TONE[entry.kind] ?? "var(--muted)" }}>
          {KIND_LABEL[entry.kind] ?? entry.kind}
        </span>
        <span>{stamp}</span>
        {url && (
          <span className="open" aria-hidden>
            <Icon name="arrowUpRight" />
          </span>
        )}
      </div>
    </Card>
  );
}

function ChronicleList({ entries, compact = false, offset = 0 }: { entries: ChronicleEntry[]; compact?: boolean; offset?: number }) {
  return (
    <>
      {entries.map((entry, index) => (
        <ChronicleCard key={entry.id} entry={entry} index={offset + index} compact={compact} />
      ))}
    </>
  );
}

const DAYS = ["1", "3", "7", "30"] as const;
type Days = (typeof DAYS)[number];
const PERIOD: Record<Days, string> = { "1": "24 hours", "3": "3 days", "7": "week", "30": "month" };

const dayKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

function dayLabel(date: Date): string {
  const now = new Date();
  if (dayKey(date) === dayKey(now)) return "today";
  if (dayKey(date) === dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return "yesterday";
  return date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

/** Local days, newest first; inside a day the chronicler's importance order stays. */
function groupByDay(entries: ChronicleEntry[]): { key: string; label: string; entries: ChronicleEntry[] }[] {
  const groups = new Map<string, { key: string; label: string; entries: ChronicleEntry[] }>();
  for (const entry of entries) {
    const date = new Date(entry.period_to);
    const key = dayKey(date);
    const group = groups.get(key);
    if (group) group.entries.push(entry);
    else groups.set(key, { key, label: dayLabel(date), entries: [entry] });
  }
  return [...groups.values()].sort((a, b) => b.key.localeCompare(a.key));
}

function ChronicleScreen() {
  const [days, setDays] = useRemembered<Days>("chronicle.days", "3");
  const { data, error, reload, pending, dataPath } = useLoad<{ entries: ChronicleEntry[] }>(`/chronicle?days=${days}`);
  if (!data && error) return <LoadState error={error} retry={reload} skeleton="cards" />;
  const dataDays = DAYS.find((candidate) => dataPath?.endsWith(`days=${candidate}`)) ?? days;
  const entries = data?.entries ?? [];
  const reading = pending && !error;
  const terminal = !data ? "reading the chat" : reading ? "reading the chat…" : `${plural(entries.length, "entry", "entries")} · last ${PERIOD[dataDays]}`;
  let shown = 0;
  return (
    <>
      <Title eyebrow="chronicle" terminal={terminal} pending={reading}>
        What <span className="accent">mattered</span>
      </Title>
      <Segmented label="Period" value={days} options={[["1", "Day"], ["3", "3 days"], ["7", "Week"], ["30", "Month"]]} onChange={setDays} />
      {(!data || error) && <LoadState error={error} retry={reload} skeleton="cards" hasData={data !== null} />}
      {data && (
        <div className={cx(reading && "stale")} key={dataPath ?? undefined}>
          {entries.length === 0 ? (
            <HiveState
              compact
              title={
                <>
                  All <span className="accent">quiet</span>
                </>
              }
              line={`nothing important · last ${PERIOD[dataDays]}`}
              action={
                dataDays !== "30" && (
                  <button
                    className="chip-btn"
                    onClick={() => {
                      haptic("select");
                      setDays("30");
                    }}
                  >
                    Show the month
                  </button>
                )
              }
            />
          ) : (
            groupByDay(entries).map((group) => {
              const offset = shown;
              shown += group.entries.length;
              return (
                <section key={group.key} className="day">
                  <h2 className="day-label">
                    <Glyph>//</Glyph>
                    {group.label}
                  </h2>
                  <ChronicleList entries={group.entries} offset={offset + 4} />
                </section>
              );
            })
          )}
        </div>
      )}
    </>
  );
}

// ---------- notes ----------

const NOTE_ERRORS: Record<string, string> = {
  too_long: "too long — 300 characters at most",
  personal_data: "no phone numbers, emails or other personal data here",
  forbidden: "that’s a topic the bot never keeps",
  names_someone: "a note is about you or your project — leave other people out",
  too_many: "20 notes already — remove an old one first",
  opted_out: "your card is off — turn it back on first",
  forbidden_project: "only the project’s authors write notes on it",
};

const noteDate = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** Notes people wrote themselves, newest first, each dated, with a delete button where the viewer may use it. */
function NoteList({ memos, canDelete, onDelete, busy, byline }: { memos: Memo[]; canDelete: (memo: Memo) => boolean; onDelete: (memo: Memo) => void; busy: number | null; byline?: (memo: Memo) => string | null }) {
  return (
    <>
      {memos.map((memo) => (
        <div key={memo.id} className="edit-row note-row">
          <div className="grow">
            <span lang={langOf(memo.text)}>{memo.text}</span>
            <span className="note-meta">{[byline?.(memo), noteDate(memo.created_at)].filter(Boolean).join(" · ")}</span>
          </div>
          {canDelete(memo) && (
            <div className="row-actions">
              <button className="icon-btn reject" aria-label={`Delete the note “${memo.text}”`} disabled={busy === memo.id} onClick={() => onDelete(memo)}>
                <Icon name="close" />
              </button>
            </div>
          )}
        </div>
      ))}
    </>
  );
}

/** A note to add: the server checks what it says, and its refusal is shown in plain words. */
function NoteForm({ projectId, placeholder, onAdded }: { projectId: number | null; placeholder: string; onAdded: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const add = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    setFailed(null);
    try {
      await api("/memos", { method: "POST", body: { text: value, project_id: projectId } });
      haptic("success");
      setText("");
      onAdded();
    } catch (error) {
      haptic("error");
      const code = error instanceof ApiError ? (error.code === "forbidden" ? "forbidden_project" : error.code) : "";
      setFailed(NOTE_ERRORS[code] ?? "couldn’t add it — try again");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="note-form">
      <AutoTextarea rows={2} maxLength={300} aria-label="New note" placeholder={placeholder} lang={langOf(text)} value={text} onChange={(event) => setText(event.target.value)} />
      <div className="field-foot">
        <span className={cx("field-count", text.length >= 280 && "near")}>{text.length}/300</span>
      </div>
      <button className="btn small" disabled={!text.trim() || busy} onClick={() => void add()}>
        <Icon name="plus" />
        Add a note
      </button>
      {failed && (
        <div className="form-error" role="alert">
          <Glyph>&gt;</Glyph>
          {failed}
        </div>
      )}
    </div>
  );
}

/** Deletes a note after a confirmation; true once it is gone. */
async function deleteNote(memo: Memo): Promise<boolean> {
  if (!(await tgConfirm(`Delete the note “${memo.text.slice(0, 80)}”?`))) return false;
  try {
    await api(`/memos/${memo.id}`, { method: "DELETE" });
    haptic("success");
    return true;
  } catch {
    haptic("error");
    tgAlert("Couldn’t delete it — try again");
    return false;
  }
}

// ---------- me ----------

interface MeResponse {
  user: { id: number; display_name: string; username: string | null; tagline: string | null; tagline_manual: boolean; opted_out: boolean; is_admin?: boolean };
  facts: Fact[];
  projects: Project[];
  memos?: Memo[];
}

const MANUAL_KINDS = ["role", "stack", "expertise", "interest", "looking_for", "can_help", "link", "timezone"] as const;
type ManualKind = (typeof MANUAL_KINDS)[number];

const PLACEHOLDER: Record<ManualKind, string> = {
  role: "e.g. backend developer",
  stack: "e.g. Rust",
  expertise: "e.g. Telegram bots",
  interest: "e.g. climbing",
  looking_for: "e.g. a co-founder",
  can_help: "e.g. code review",
  link: "https://…",
  timezone: "e.g. Warsaw",
};

type Busy = number | "add" | "tagline" | "collect" | null;

function EditRow({ fact, children }: { fact: Fact; children: ReactNode }) {
  return (
    <div className="edit-row">
      <div className="grow" lang={langOf(fact.value)}>
        {fact.value}
        {fact.status === "manual" && <span className="tag">yours</span>}
      </div>
      <div className="row-actions">{children}</div>
    </div>
  );
}

function FactGroups({ facts, actions }: { facts: Fact[]; actions: (fact: Fact) => ReactNode }) {
  return (
    <>
      {groupFacts(facts).map(([kind, items]) => (
        <div key={kind} className="dossier-row">
          <div className="kind">{FACT_LABELS[kind] ?? kind}</div>
          {items.map((fact) => (
            <EditRow key={fact.id} fact={fact}>
              {actions(fact)}
            </EditRow>
          ))}
        </div>
      ))}
    </>
  );
}

function MeScreen({ go }: { go: Go }) {
  const { data, error, reload } = useLoad<MeResponse>("/me");
  const [draft, setDraft] = useState<string | null>(null);
  const [kind, setKind] = useState<ManualKind>("stack");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [addFailed, setAddFailed] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [noteBusy, setNoteBusy] = useState<number | null>(null);
  const closeToast = useCallback(() => setToast(null), []);
  // A saved tagline drops the draft only once the fresh card carries it, so the old text never flashes back.
  const savedTagline = data?.user.tagline ?? "";
  useEffect(() => setDraft(null), [savedTagline]);

  if (!data && error) return <LoadState error={error} retry={reload} skeleton="cards" />;

  /** Every change: success → haptic and a fresh card; failure → haptic and a toast. */
  const run = async (key: Exclude<Busy, null>, request: () => Promise<unknown>): Promise<boolean> => {
    setBusy(key);
    try {
      await request();
      haptic("success");
      reload();
      return true;
    } catch {
      haptic("error");
      setToast({ id: Date.now(), text: "Couldn’t update — try again" });
      return false;
    } finally {
      setBusy(null);
    }
  };
  const post = (path: string) => () => api(path, { method: "POST", body: {} });
  const restore = (fact: Fact) => run(fact.id, post(`/facts/${fact.id}/restore`));
  const hide = async (fact: Fact) => {
    if (await run(fact.id, post(`/facts/${fact.id}/hide`))) setToast({ id: Date.now(), text: "Hidden", undo: () => void restore(fact) });
  };
  const reject = async (fact: Fact) => {
    setBusy(fact.id);
    const sure = await tgConfirm(`Remove “${fact.value}” for good? The chronicler won’t add it again.`);
    if (sure) await run(fact.id, post(`/facts/${fact.id}/reject`));
    else setBusy(null);
  };
  const add = async () => {
    const text = value.trim();
    if (!text || busy === "add") return;
    setBusy("add");
    setAddFailed(false);
    try {
      await api("/me/facts", { method: "POST", body: { kind, value: kind === "link" ? withScheme(text) : text } });
      haptic("success");
      setValue("");
      reload();
    } catch {
      haptic("error");
      setAddFailed(true);
    } finally {
      setBusy(null);
    }
  };

  const hideButton = (fact: Fact) => (
    <button className="icon-btn" aria-label={`Hide “${fact.value}”`} disabled={busy === fact.id} onClick={() => void hide(fact)}>
      <Icon name="eyeOff" />
    </button>
  );
  const rejectButton = (fact: Fact) => (
    <button className="icon-btn reject" aria-label={`Remove “${fact.value}” for good`} disabled={busy === fact.id} onClick={() => void reject(fact)}>
      <Icon name="close" />
    </button>
  );
  const restoreButton = (fact: Fact) => (
    <button className="icon-btn" aria-label={`Restore “${fact.value}”`} disabled={busy === fact.id} onClick={() => void restore(fact)}>
      <Icon name="restore" />
    </button>
  );

  const facts = data?.facts ?? [];
  const visible = facts.filter((fact) => fact.status !== "hidden" && (fact.status === "manual" || fact.confidence >= 0.6));
  const hidden = facts.filter((fact) => fact.status === "hidden");
  const unsure = facts.filter((fact) => fact.status === "auto" && fact.confidence < 0.6);
  const terminal = !data
    ? "loading your card"
    : data.user.opted_out
      ? "collection is off"
      : `${plural(visible.length, "fact", "facts")} on your card${hidden.length > 0 ? ` · ${hidden.length} hidden` : ""}`;
  const tagline = draft ?? savedTagline;

  return (
    <>
      <Title eyebrow="my card" terminal={terminal}>
        {data ? <span lang={langOf(data.user.display_name)}>{data.user.display_name}</span> : <span className="sk sk-title" />}
      </Title>
      {error && <LoadState error={error} retry={reload} skeleton="cards" hasData />}
      {!data ? (
        <Skeleton kind="cards" />
      ) : data.user.opted_out ? (
        <HiveState
          compact
          title={
            <>
              Collection is <span className="accent">off</span>
            </>
          }
          line="nothing is collected about you"
          action={
            <button className="btn" disabled={busy === "collect"} onClick={() => void run("collect", () => api("/me", { method: "PATCH", body: { opted_out: false } }))}>
              Turn my card back on
            </button>
          }
        />
      ) : (
        <>
          <Section label="tagline" index={3}>
            <Card>
              <AutoTextarea
                rows={2}
                maxLength={90}
                aria-label="Tagline"
                placeholder="Who you are, in one line"
                enterKeyHint="done"
                lang={langOf(tagline)}
                value={tagline}
                onChange={(event) => setDraft(event.target.value.replace(/\s*\n\s*/g, " "))}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  event.currentTarget.blur();
                }}
              />
              <div className="field-foot">
                <span className={cx("field-count", tagline.length >= 80 && "near")}>{tagline.length}/90</span>
              </div>
              {draft !== null && draft.trim() !== savedTagline && (
                <div className="form-actions">
                  <button className="btn small" disabled={busy === "tagline"} onClick={() => void run("tagline", () => api("/me", { method: "PATCH", body: { tagline: draft || null } }))}>
                    Save
                  </button>
                  <button className="btn outline small" onClick={() => setDraft(null)}>
                    Cancel
                  </button>
                </div>
              )}
            </Card>
          </Section>

          <Section label="notes" index={4}>
            <Card className="dossier">
              {(data.memos ?? []).length === 0 ? (
                <div className="hint">Plans, news, what you’re after — in your own words. You can also ask the bot in the chat: “add a note: …”.</div>
              ) : (
                <NoteList
                  memos={data.memos ?? []}
                  canDelete={() => true}
                  busy={noteBusy}
                  byline={(memo) => (memo.project_name ? `on ${memo.project_name}` : null)}
                  onDelete={async (memo) => {
                    setNoteBusy(memo.id);
                    if (await deleteNote(memo)) reload();
                    setNoteBusy(null);
                  }}
                />
              )}
              <NoteForm projectId={null} placeholder="A note about you, in your own words" onAdded={reload} />
            </Card>
          </Section>

          <Section label="visible to everyone" index={4}>
            <Card className="dossier">
              {visible.length === 0 ? (
                <div className="hint">Empty for now — add something below.</div>
              ) : (
                <FactGroups
                  facts={visible}
                  actions={(fact) => (
                    <>
                      {hideButton(fact)}
                      {rejectButton(fact)}
                    </>
                  )}
                />
              )}
            </Card>
          </Section>

          <Section label="add a fact" index={5}>
            <Card className="form">
              <div className="field">
                <span className="field-label">Kind</span>
                <div className="kind-picker" role="group" aria-label="Kind">
                  {MANUAL_KINDS.map((item) => (
                    <button
                      key={item}
                      className="pick"
                      aria-pressed={kind === item}
                      onClick={() => {
                        haptic("select");
                        setKind(item);
                      }}
                    >
                      {FACT_LABELS[item] ?? item}
                    </button>
                  ))}
                </div>
              </div>
              <label className="field">
                <span className="field-label">Value</span>
                <input
                  className="input"
                  placeholder={PLACEHOLDER[kind]}
                  maxLength={160}
                  enterKeyHint="done"
                  {...(kind === "link" ? URL_INPUT : {})}
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void add();
                  }}
                />
              </label>
              <button className="btn small" disabled={!value.trim() || busy === "add"} onClick={() => void add()}>
                <Icon name="plus" />
                Add
              </button>
              {addFailed && (
                <div className="form-error" role="alert">
                  <Glyph>&gt;</Glyph>couldn’t add it — try again
                </div>
              )}
            </Card>
          </Section>

          {hidden.length > 0 && (
            <Section label="hidden" index={6}>
              <Card className="dossier">
                <FactGroups facts={hidden} actions={restoreButton} />
                <div className="hint dossier-note">Only you see these.</div>
              </Card>
            </Section>
          )}

          {unsure.length > 0 && (
            <Section label="not sure yet" index={7}>
              <Card className="dossier unsure">
                <FactGroups facts={unsure} actions={rejectButton} />
                <div className="hint dossier-note">Others don’t see these until the chronicler finds more evidence.</div>
              </Card>
            </Section>
          )}
        </>
      )}

      {data && (
        <Section label="my projects" index={8}>
          <Card className="board">
            {data.projects.map((project) => (
              <ProjectRow key={project.id} project={project} showAuthors={false} onOpen={() => go(`/p/${project.slug}`)} />
            ))}
            <button className="board-add" onClick={() => go("/projects?add=1")}>
              <Icon name="plus" />
              Add a project
            </button>
          </Card>
        </Section>
      )}
      {toast && <Toast key={toast.id} text={toast.text} undo={toast.undo} onClose={closeToast} />}
    </>
  );
}

// ---------- shell ----------

const TABS: [string, ReactNode, string][] = [
  [
    "/people",
    <svg {...ICON}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" />
      <path d="M16 5.2a3 3 0 0 1 0 5.6M17.5 14.3c1.7.6 2.7 2.2 3 4.7" />
    </svg>,
    "People",
  ],
  [
    "/projects",
    <svg {...ICON}>
      <path d="M12 3l7.5 4.3v9.4L12 21l-7.5-4.3V7.3z" />
      <path d="M12 8.5l3 1.7v3.6l-3 1.7-3-1.7v-3.6z" />
    </svg>,
    "Rating",
  ],
  [
    "/chronicle",
    <svg {...ICON}>
      <path d="M6 4h10a2 2 0 0 1 2 2v14l-3-2-3 2-3-2-3 2V4z" />
      <path d="M9 9h6M9 13h4" />
    </svg>,
    "Chronicle",
  ],
  [
    "/me",
    <svg {...ICON}>
      <circle cx="12" cy="8.5" r="3.6" />
      <path d="M5 20c.8-3.8 3.7-6 7-6s6.2 2.2 7 6" />
    </svg>,
    "Me",
  ],
];

function ChatSwitcher({ chats, current, onPick }: { chats: ChatInfo[]; current: string | null; onPick: (key: string) => void }) {
  const [open, setOpen] = useState(current === null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onHash = () => setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("hashchange", onHash);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("hashchange", onHash);
    };
  }, [open]);
  if (chats.length < 2) return null;
  const active = chats.find((chat) => chat.key === current);
  return (
    <div className="chat-switcher" ref={ref}>
      <button
        className="chat-current"
        aria-expanded={open}
        onClick={() => {
          haptic("select");
          setOpen((value) => !value);
        }}
      >
        <span className="ellipsis" lang={langOf(active?.title)}>
          {active?.title ?? "Pick a chat"}
        </span>
        <Icon name="chevron" className="chev" />
      </button>
      {open && (
        <div className="chat-list" role="group" aria-label="Your chats">
          <div className="chat-list-head" aria-hidden>
            {"// your chats"}
          </div>
          {chats.map((chat) => (
            <button
              key={chat.key}
              aria-current={chat.key === current ? "true" : undefined}
              onClick={() => {
                haptic("select");
                setOpen(false);
                onPick(chat.key);
              }}
            >
              <span lang={langOf(chat.title)}>{chat.title ?? chat.key}</span>
              {chat.key === current && <Icon name="check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function App() {
  const { route, kind, go } = useRoute();
  useTelegramTheme();
  const chats = useLoad<{ chats: ChatInfo[]; current: string | null }>("/chats");
  const [chat, setChat] = useState<string | null>(chatFromLaunch());

  useEffect(() => {
    tg?.ready();
    tg?.expand();
  }, []);

  // A chat from the launch link wins if the person is in it; else the one picked last time.
  useEffect(() => {
    if (!chats.data) return;
    const known = chats.data.chats.some((candidate) => candidate.key === chat);
    const next = known ? chat : chats.data.current;
    setCurrentChat(next);
    if (next !== chat) setChat(next);
  }, [chats.data, chat]);

  const [path = "/people", query = ""] = route.split("?");
  const depth = path.split("/").filter(Boolean).length;
  useEffect(() => {
    if (!tg) return;
    if (depth > 1) {
      tg.BackButton.show();
      tg.BackButton.onClick(goUp);
    } else tg.BackButton.hide();
    return () => tg?.BackButton.offClick(goUp);
  }, [depth]);

  const [, section, param] = path.split("/");
  const known = chats.data?.chats.some((candidate) => candidate.key === chat) ?? false;
  const ready = chats.data !== null && known;
  // The chat the effect above is settling on; the switcher must not open just because that effect hasn't run yet.
  const settled = chats.data && !known ? chats.data.current : chat;
  let screen: ReactNode;
  if (!ready) {
    // While the effect above settles on the remembered chat, keep the skeleton instead of flashing "Which hive?".
    const code = chats.error ?? (!chats.data ? null : chats.data.chats.length === 0 ? "not_a_member" : chats.data.current === null ? "choose_chat" : null);
    screen = <LoadState error={code} retry={chats.reload} skeleton="cards" />;
  } else if (section === "u" && param) screen = <PersonScreen id={param} go={go} />;
  else if (section === "p" && param) screen = <ProjectScreen slug={decodeURIComponent(param)} go={go} />;
  else if (section === "projects") screen = <ProjectsScreen go={go} startAdding={new URLSearchParams(query).has("add")} />;
  else if (section === "chronicle") screen = <ChronicleScreen />;
  else if (section === "me") screen = <MeScreen go={go} />;
  else screen = <PeopleScreen go={go} />;

  const activeTab = section === "u" ? "/people" : section === "p" ? "/projects" : `/${section || "people"}`;
  return (
    <div className="app">
      <HexBackdrop />
      <header className="topbar">
        <span className="brand">
          <HexMark />
          waggle
        </span>
        {chats.data && (
          <ChatSwitcher
            chats={chats.data.chats}
            current={settled}
            onPick={(key) => {
              setCurrentChat(key);
              setChat(key);
              go("/people");
            }}
          />
        )}
      </header>
      <main key={`${chat}:${path}`} className={cx("screen", kind === "back" && "instant")}>
        {screen}
      </main>
      {ready && (
        <nav className="tabs" aria-label="Sections">
          {TABS.map(([to, icon, label]) => (
            <button
              key={to}
              className={cx("tab", activeTab === to && "active")}
              aria-current={activeTab === to ? "page" : undefined}
              onClick={() => {
                haptic("select");
                if (activeTab === to && depth === 1) window.scrollTo({ top: 0, behavior: reducedMotion() ? "auto" : "smooth" });
                else go(to);
              }}
            >
              {icon}
              {label}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}
