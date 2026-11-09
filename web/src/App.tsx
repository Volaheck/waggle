import { useCallback, useEffect, useState, type MouseEvent, type ReactNode } from "react";
import {
  api,
  ApiError,
  FACT_LABELS,
  haptic,
  openTelegram,
  SIGNAL_EMOJI,
  STATUS_EMOJI,
  STATUSES,
  tg,
  type ChronicleEntry,
  type Fact,
  type PersonSummary,
  type Project,
} from "./api";

// ---------- routing ----------

function routeFromStartParam(param: string | undefined): string | null {
  if (!param) return null;
  if (param.startsWith("u_")) return `/u/${param.slice(2)}`;
  if (param.startsWith("p_")) return `/p/${param.slice(2)}`;
  if (["me", "projects", "people", "chronicle"].includes(param)) return `/${param}`;
  return null;
}

function useRoute(): [string, (to: string) => void] {
  // Telegram puts its own data into the hash (#tgWebAppData=…); only "#/…" is a route.
  const read = () => {
    const hash = window.location.hash.replace(/^#/, "");
    return hash.startsWith("/") ? hash : "/people";
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const go = useCallback((to: string) => {
    window.location.hash = to;
  }, []);
  return [route, go];
}

function useLoad<T>(path: string | null): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setError(null);
    api<T>(path)
      .then((result) => !cancelled && setData(result))
      .catch((err: unknown) => !cancelled && setError(err instanceof ApiError ? err.code : "network"));
    return () => {
      cancelled = true;
    };
  }, [path, tick]);
  return { data, error, reload: () => setTick((value) => value + 1) };
}

const ERROR_TEXT: Record<string, string> = {
  unauthorized: "Открой приложение из Telegram — через бота чата.",
  not_a_member: "Приложение только для участников чата 🐝",
  network: "Нет связи с сервером. Попробуй ещё раз.",
};

function Status({ error, loading }: { error: string | null; loading: boolean }) {
  if (error) return <div className="empty error">{ERROR_TEXT[error] ?? "Что-то пошло не так."}</div>;
  if (loading)
    return (
      <>
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="skeleton" style={{ opacity: 1 - index * 0.2 }} />
        ))}
      </>
    );
  return null;
}

function hueOf(text: string): number {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.codePointAt(0)!) % 360;
  return hash;
}

function Avatar({ name, big = false }: { name: string; big?: boolean }) {
  return (
    <div className={`avatar ${big ? "big" : ""}`} style={{ ["--h" as string]: hueOf(name) }}>
      {name.trim().charAt(0).toUpperCase() || "?"}
    </div>
  );
}

function Card({ children, onClick, className = "", index = 0 }: { children: ReactNode; onClick?: () => void; className?: string; index?: number }) {
  return (
    <div
      className={`card ${onClick ? "tap" : ""} ${className}`}
      style={{ ["--i" as string]: Math.min(index, 12) }}
      onClick={
        onClick
          ? () => {
              haptic();
              onClick();
            }
          : undefined
      }
    >
      {children}
    </div>
  );
}

function Title({ emoji, children }: { emoji: string; children: ReactNode }) {
  return (
    <div className="title">
      <span className="emoji">{emoji}</span>
      {children}
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (value: T) => void }) {
  const index = Math.max(0, options.findIndex(([key]) => key === value));
  return (
    <div className="segmented">
      <div className="pill" style={{ width: `calc((100% - 8px) / ${options.length})`, transform: `translateX(${index * 100}%)` }} />
      {options.map(([key, label]) => (
        <button
          key={key}
          className={key === value ? "active" : ""}
          onClick={() => {
            haptic();
            onChange(key);
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function ScoreRing({ score, max, big = false }: { score: number; max: number; big?: boolean }) {
  const percent = max > 0 ? Math.max(6, Math.round((score / max) * 100)) : 6;
  return (
    <div className={`score-ring ${big ? "big" : ""}`} style={{ ["--p" as string]: percent }}>
      <b>{score}</b>
    </div>
  );
}

const MEDALS = ["🥇", "🥈", "🥉"];

function burstFrom(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  for (let index = 0; index < 6; index += 1) {
    const spark = document.createElement("div");
    spark.className = "burst";
    spark.textContent = "👍";
    const angle = (Math.PI * 2 * index) / 6;
    spark.style.left = `${rect.left + rect.width / 2 - 11}px`;
    spark.style.top = `${rect.top + rect.height / 2 - 11}px`;
    spark.style.setProperty("--dx", `${Math.cos(angle) * 56}px`);
    spark.style.setProperty("--dy", `${Math.sin(angle) * 56 - 24}px`);
    spark.style.setProperty("--rot", `${(index % 2 ? 1 : -1) * 40}deg`);
    document.body.appendChild(spark);
    setTimeout(() => spark.remove(), 950);
  }
  element.classList.remove("pop");
  void element.offsetWidth;
  element.classList.add("pop");
}

const THEME_BG = { dark: "#06060c", light: "#f3f4fb" } as const;

function useTelegramTheme() {
  useEffect(() => {
    // Outside Telegram the SDK still exists but always reports "light", so trust it only inside Telegram.
    const insideTelegram = Boolean(tg?.initData);
    const apply = () => {
      const scheme = insideTelegram ? tg!.colorScheme : window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
      document.documentElement.dataset.theme = scheme;
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

function Backdrop() {
  return (
    <div className="backdrop" aria-hidden>
      <div className="blob b1" />
      <div className="blob b2" />
      <div className="blob b3" />
    </div>
  );
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault();
        openTelegram(href);
      }}
    >
      {children}
    </a>
  );
}

// ---------- people ----------

function PeopleScreen({ go }: { go: (to: string) => void }) {
  const { data, error } = useLoad<{ people: PersonSummary[] }>("/people");
  const people = data?.people ?? [];
  return (
    <>
      <Title emoji="👥">Участники</Title>
      <Status error={error} loading={!data} />
      {people.map((person, index) => (
        <Card key={person.id} index={index} onClick={() => go(`/u/${person.id}`)}>
          <div className="row top">
            <Avatar name={person.display_name} />
            <div className="grow">
              <div className="name ellipsis">
                {person.display_name} {person.username && <span className="hint">@{person.username}</span>}
              </div>
              {person.tagline && <div className="hint ellipsis">{person.tagline}</div>}
              {person.top_facts.length > 0 && (
                <div className="chips">
                  {person.top_facts.slice(0, 2).map((fact) => (
                    <span key={fact} className="chip">
                      {fact}
                    </span>
                  ))}
                </div>
              )}
            </div>
            {person.project_count > 0 && <span className="chip accent">🛠 {person.project_count}</span>}
          </div>
        </Card>
      ))}
    </>
  );
}

/** Short values read better as tags than as rows. */
const CHIP_KINDS = new Set(["stack", "interest", "timezone"]);

function groupFacts(facts: Fact[]): [string, Fact[]][] {
  const groups = new Map<string, Fact[]>();
  for (const fact of facts) groups.set(fact.kind, [...(groups.get(fact.kind) ?? []), fact]);
  return [...groups.entries()];
}

function PersonScreen({ id, go }: { id: string; go: (to: string) => void }) {
  const { data, error } = useLoad<{
    person: PersonSummary;
    facts: Fact[];
    projects: Project[];
    messages_30d: number;
    can_edit: boolean;
  }>(`/people/${id}`);
  if (!data) return <Status error={error} loading />;
  const { person, facts, projects } = data;
  return (
    <>
      <Card className="hero">
        <div className="row">
          <Avatar name={person.display_name} big />
          <div className="grow">
            <div className="title" style={{ margin: 0, fontSize: 22 }}>
              {person.display_name}
            </div>
            {person.username && (
              <ExternalLink href={`https://t.me/${person.username}`}>@{person.username}</ExternalLink>
            )}
          </div>
        </div>
        {person.tagline && <p>{person.tagline}</p>}
        <div className="hint">Сообщений за 30 дней: {data.messages_30d}</div>
        {data.can_edit && (
          <button className="btn secondary small" style={{ marginTop: 8 }} onClick={() => go("/me")}>
            ✏️ Править мою карточку
          </button>
        )}
      </Card>
      {person.opted_out && <div className="empty">Попросил(а) ничего о себе не собирать.</div>}
      {groupFacts(facts).map(([kind, items]) => (
        <div key={kind}>
          <div className="section-title">{FACT_LABELS[kind] ?? kind}</div>
          <Card>
            {CHIP_KINDS.has(kind) ? (
              <div className="chips" style={{ marginTop: 0 }}>
                {items.map((fact) => (
                  <span key={fact.id} className="chip big">
                    {fact.value}
                  </span>
                ))}
              </div>
            ) : (
              items.map((fact) => (
                <div key={fact.id} className="fact">
                  <div className="grow">{fact.kind === "link" ? <ExternalLink href={fact.value}>{fact.value.replace(/^https?:\/\/(www\.)?/, "")}</ExternalLink> : fact.value}</div>
                  {fact.sources[0] && (
                    <ExternalLink href={fact.sources[0].url}>
                      <span className="source" title="Сообщение, откуда это известно">↗</span>
                    </ExternalLink>
                  )}
                </div>
              ))
            )}
          </Card>
        </div>
      ))}
      {projects.length > 0 && <div className="section-title">Проекты в каталоге</div>}
      {projects.map((project) => (
        <Card key={project.id} onClick={() => go(`/p/${project.slug}`)}>
          <div className="name">
            {STATUS_EMOJI[project.status]} {project.name}
          </div>
          {project.tagline && <div className="hint">{project.tagline}</div>}
        </Card>
      ))}
    </>
  );
}

// ---------- projects ----------

type Sort = "top" | "alive" | "new";

function ProjectsScreen({ go }: { go: (to: string) => void }) {
  const [sort, setSort] = useState<Sort>("top");
  const { data, error, reload } = useLoad<{ projects: Project[] }>(`/projects?sort=${sort}`);
  const [adding, setAdding] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const maxScore = Math.max(1, ...(data?.projects.map((project) => project.score) ?? [1]));
  return (
    <>
      <div className="row">
        <div className="grow">
          <Title emoji="🏆">Проекты</Title>
        </div>
        <button className="btn small" onClick={() => setAdding((value) => !value)}>
          {adding ? "Отмена" : "＋ Свой"}
        </button>
      </div>
      {adding && (
        <ProjectForm
          onDone={(slug) => {
            setAdding(false);
            reload();
            if (slug) go(`/p/${slug}`);
          }}
        />
      )}
      <Segmented value={sort} options={[["top", "Топ"], ["alive", "Живые"], ["new", "Новые"]]} onChange={setSort} />
      <Status error={error} loading={!data} />
      {data?.projects.map((project, index) => (
        <Card key={project.id} index={index} className={sort === "top" && index < 3 ? "highlight" : ""} onClick={() => go(`/p/${project.slug}`)}>
          <div className="row">
            <div className={`rank ${sort === "top" && index < 3 ? "medal" : ""}`}>{sort === "top" && index < 3 ? MEDALS[index] : index + 1}</div>
            <div className="grow">
              <div className="name">
                {STATUS_EMOJI[project.status]} {project.name}
              </div>
              {project.tagline && <div className="hint clamp2">{project.tagline}</div>}
              <div className="hint" style={{ fontWeight: 700 }}>{project.authors.map((author) => author.display_name).join(", ")}</div>
            </div>
            <ScoreRing score={project.score} max={maxScore} />
          </div>
        </Card>
      ))}
      <button className="btn secondary small" onClick={() => setShowHelp((value) => !value)}>
        ❓ Как считается рейтинг
      </button>
      {showHelp && (
        <Card className="hint">
          Рейтинг ведёт летописец — нейронка, которая раз в несколько часов читает чат. Она замечает, что реально происходит с проектами: отзывы
          участников, кто чем пользуется, кто помогает, как проект развивается, — и сама решает, насколько это весомо. Голоса 👍 участников тоже
          учитываются. Свежее весит больше старого, а накрутить рейтинг повторными упоминаниями не получится.
        </Card>
      )}
    </>
  );
}

function ProjectForm({ onDone }: { onDone: (slug?: string) => void }) {
  const [name, setName] = useState("");
  const [tagline, setTagline] = useState("");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const isRepo = /github\.com|gitlab\.com|codeberg\.org/.test(link);
      const result = await api<{ slug: string }>("/projects", {
        method: "POST",
        body: { name, tagline: tagline || null, repo: isRepo ? link : null, site: !isRepo && link ? link : null },
      });
      haptic("success");
      onDone(result.slug);
    } catch {
      haptic("error");
      setBusy(false);
    }
  };
  return (
    <Card>
      <input className="input" placeholder="Название" value={name} onChange={(event) => setName(event.target.value)} />
      <div style={{ height: 8 }} />
      <input className="input" placeholder="Одной фразой — что это" value={tagline} onChange={(event) => setTagline(event.target.value)} />
      <div style={{ height: 8 }} />
      <input className="input" placeholder="Ссылка (репозиторий или сайт)" value={link} onChange={(event) => setLink(event.target.value)} />
      <div style={{ height: 10 }} />
      <button className="btn" disabled={!name.trim() || busy} onClick={submit}>
        Добавить
      </button>
    </Card>
  );
}

function ProjectScreen({ slug, go }: { slug: string; go: (to: string) => void }) {
  const { data, error, reload } = useLoad<{
    project: Project;
    can_edit: boolean;
    first_seen_url: string | null;
    discussions: { msg_id: number; text: string; display_name: string | null; url: string }[];
    history: ChronicleEntry[];
  }>(`/projects/${slug}`);
  const [editing, setEditing] = useState(false);
  if (!data) return <Status error={error} loading />;
  const { project } = data;
  const links = [project.links.repo, project.links.site, ...(project.links.other ?? [])].filter((link): link is string => Boolean(link));
  const vote = async (event: MouseEvent<HTMLButtonElement>) => {
    const button = event.currentTarget;
    try {
      await api(`/projects/${project.id}/vote`, { method: "POST", body: { voted: !project.voted_by_me } });
      haptic("success");
      if (!project.voted_by_me) burstFrom(button);
      reload();
    } catch (err) {
      haptic("error");
      if (err instanceof ApiError && err.code === "own_project") alert("За свой проект голосовать нельзя 🙂");
    }
  };
  return (
    <>
      <Card className="hero">
        <div className="row">
          <div className="grow">
            <div className="title" style={{ margin: 0, fontSize: 24 }}>
              {project.name}
            </div>
            <span className="chip accent">
              {STATUS_EMOJI[project.status]} {project.status}
            </span>
          </div>
          <ScoreRing score={project.score} max={Math.max(project.score, 30)} big />
        </div>
        {project.tagline && <p>{project.tagline}</p>}
        {project.stack.length > 0 && (
          <div className="chips">
            {project.stack.map((item) => (
              <span key={item} className="chip">
                {item}
              </span>
            ))}
          </div>
        )}
        {links.map((link) => (
          <div key={link} style={{ marginTop: 6 }}>
            <ExternalLink href={link}>{link.replace(/^https?:\/\//, "")}</ExternalLink>
          </div>
        ))}
        <div className="row" style={{ marginTop: 12, gap: 8, flexWrap: "wrap" }}>
          <button className={`btn ${project.voted_by_me ? "secondary" : ""}`} onClick={vote}>
            👍 {project.votes} {project.voted_by_me ? "· убрать" : "· голосую"}
          </button>
          {data.can_edit && (
            <button className="btn secondary" onClick={() => setEditing((value) => !value)}>
              {editing ? "Готово" : "✏️ Править"}
            </button>
          )}
        </div>
      </Card>
      {editing && <ProjectEditor project={project} onSaved={reload} onDeleted={() => go("/projects")} />}
      <div className="section-title">Авторы</div>
      {project.authors.map((author) => (
        <Card key={author.id} onClick={() => go(`/u/${author.id}`)}>
          <div className="row">
            <Avatar name={author.display_name} />
            <div className="grow">
              <div className="name">{author.display_name}</div>
              {author.role && <div className="hint">{author.role}</div>}
            </div>
          </div>
        </Card>
      ))}
      {project.recent_signals.length > 0 && <div className="section-title">Что говорят</div>}
      {project.recent_signals.length > 0 && (
        <Card>
          {project.recent_signals.map((signal, index) => (
            <div key={index} className="signal">
              <div className="icon">{SIGNAL_EMOJI[signal.kind] ?? "•"}</div>
              <div className="grow">{signal.note}</div>
            </div>
          ))}
        </Card>
      )}
      {data.history.length > 0 && <div className="section-title">История проекта</div>}
      {data.history.length > 0 && <ChronicleList entries={data.history} />}
      {data.discussions.length > 0 && <div className="section-title">В чате</div>}
      {data.discussions.map((row) => (
        <Card key={row.msg_id} onClick={() => openTelegram(row.url)}>
          <div className="hint">{row.display_name ?? "?"}</div>
          <div>{row.text}</div>
        </Card>
      ))}
    </>
  );
}

function ProjectEditor({ project, onSaved, onDeleted }: { project: Project; onSaved: () => void; onDeleted: () => void }) {
  const [tagline, setTagline] = useState(project.tagline ?? "");
  const [status, setStatus] = useState(project.status);
  const [stack, setStack] = useState(project.stack.join(", "));
  const [repo, setRepo] = useState(project.links.repo ?? "");
  const [site, setSite] = useState(project.links.site ?? "");
  const save = async () => {
    try {
      await api(`/projects/${project.id}`, {
        method: "PATCH",
        body: {
          tagline: tagline || null,
          status,
          stack: stack.split(",").map((part) => part.trim()).filter(Boolean),
          repo: repo || null,
          site: site || null,
        },
      });
      haptic("success");
      onSaved();
    } catch {
      haptic("error");
      alert("Не сохранилось — проверь ссылки (нужен https://…)");
    }
  };
  const remove = async () => {
    if (!confirm(`Удалить «${project.name}» из каталога?`)) return;
    await api(`/projects/${project.id}`, { method: "DELETE" });
    onDeleted();
  };
  return (
    <Card>
      <select className="select" value={status} onChange={(event) => setStatus(event.target.value)}>
        {STATUSES.map((value) => (
          <option key={value} value={value}>
            {STATUS_EMOJI[value]} {value}
          </option>
        ))}
      </select>
      <div style={{ height: 8 }} />
      <textarea className="input" rows={2} placeholder="Описание" value={tagline} onChange={(event) => setTagline(event.target.value)} />
      <div style={{ height: 8 }} />
      <input className="input" placeholder="Стек через запятую" value={stack} onChange={(event) => setStack(event.target.value)} />
      <div style={{ height: 8 }} />
      <input className="input" placeholder="Репозиторий https://…" value={repo} onChange={(event) => setRepo(event.target.value)} />
      <div style={{ height: 8 }} />
      <input className="input" placeholder="Сайт https://…" value={site} onChange={(event) => setSite(event.target.value)} />
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn" onClick={save}>
          Сохранить
        </button>
        <div className="grow" />
        <button className="btn danger" onClick={remove}>
          Удалить
        </button>
      </div>
    </Card>
  );
}

// ---------- chronicle ----------

const KIND_EMOJI: Record<ChronicleEntry["kind"], string> = { discussion: "💬", project: "🛠", link: "🔗", news: "📰" };

function ChronicleList({ entries }: { entries: ChronicleEntry[] }) {
  return (
    <>
      {entries.map((entry, index) => (
        <Card key={entry.id} index={index} onClick={entry.url ? () => openTelegram(entry.url!) : undefined}>
          <div className="row" style={{ alignItems: "baseline" }}>
            <div className="name grow">
              {KIND_EMOJI[entry.kind]} {entry.title}
            </div>
            <span className="importance" title={`Важность ${entry.importance} из 5`}>
              {[1, 2, 3, 4, 5].map((level) => (
                <i key={level} className={level <= entry.importance ? "on" : ""} />
              ))}
            </span>
          </div>
          <div style={{ color: "var(--text-2)", marginTop: 4 }}>{entry.summary}</div>
          <div className="hint">{new Date(entry.period_to).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</div>
        </Card>
      ))}
    </>
  );
}

function ChronicleScreen() {
  const [days, setDays] = useState<"1" | "3" | "7" | "30">("3");
  const { data, error } = useLoad<{ entries: ChronicleEntry[] }>(`/chronicle?days=${days}`);
  return (
    <>
      <Title emoji="📜">Главное</Title>
      <div className="hint" style={{ margin: "-10px 2px 14px" }}>
        Самое важное, что произошло в чате, — летописец отбирает события по значимости.
      </div>
      <Segmented value={days} options={[["1", "Сутки"], ["3", "3 дня"], ["7", "Неделя"], ["30", "Месяц"]]} onChange={setDays} />
      <Status error={error} loading={!data} />
      {data && data.entries.length === 0 && <div className="empty">За этот период ничего важного не случилось.</div>}
      {data && <ChronicleList entries={data.entries} />}
    </>
  );
}

// ---------- me ----------

interface MeResponse {
  user: { id: number; display_name: string; username: string | null; tagline: string | null; tagline_manual: boolean; opted_out: boolean };
  facts: Fact[];
  projects: Project[];
}

const MANUAL_KINDS = ["role", "stack", "expertise", "interest", "looking_for", "can_help", "link", "timezone"];

function MeScreen({ go }: { go: (to: string) => void }) {
  const { data, error, reload } = useLoad<MeResponse>("/me");
  const [tagline, setTagline] = useState<string | null>(null);
  const [kind, setKind] = useState("stack");
  const [value, setValue] = useState("");
  if (!data) return <Status error={error} loading />;
  const act = async (path: string, body?: unknown, method = "POST") => {
    try {
      await api(path, { method, body: body ?? {} });
      haptic("success");
      reload();
    } catch {
      haptic("error");
    }
  };
  const visible = data.facts.filter((fact) => fact.status !== "hidden" && (fact.status === "manual" || fact.confidence >= 0.6));
  const hidden = data.facts.filter((fact) => fact.status === "hidden");
  const pending = data.facts.filter((fact) => fact.status === "auto" && fact.confidence < 0.6);
  const factRow = (fact: Fact, actions: ReactNode) => (
    <div key={fact.id} className="fact">
      <div className="grow">
        <span className="hint">{FACT_LABELS[fact.kind] ?? fact.kind}: </span>
        {fact.value} {fact.status === "manual" && <span title="добавлено тобой">✍️</span>}
      </div>
      <div className="actions">{actions}</div>
    </div>
  );
  return (
    <>
      <Title emoji="👤">{data.user.display_name}</Title>
      {data.user.opted_out ? (
        <Card>
          <p>🚫 Сбор информации о тебе выключен — карточки нет.</p>
          <button className="btn" onClick={() => act("/me", { opted_out: false }, "PATCH")}>
            Снова вести мою карточку
          </button>
        </Card>
      ) : (
        <>
          <div className="section-title">Однострочник</div>
          <Card>
            <input
              className="input"
              maxLength={90}
              placeholder="Кто ты одной фразой"
              value={tagline ?? data.user.tagline ?? ""}
              onChange={(event) => setTagline(event.target.value)}
            />
            {tagline !== null && tagline !== (data.user.tagline ?? "") && (
              <button
                className="btn small"
                style={{ marginTop: 8 }}
                onClick={async () => {
                  await act("/me", { tagline: tagline || null }, "PATCH");
                  setTagline(null);
                }}
              >
                Сохранить
              </button>
            )}
          </Card>

          <div className="section-title">Карточка · видят все</div>
          <Card>
            {visible.length === 0 && <div className="hint">Пока пусто — добавь что-нибудь ниже.</div>}
            {visible.map((fact) =>
              factRow(
                fact,
                <>
                  <button className="icon-btn" title="Скрыть" onClick={() => act(`/facts/${fact.id}/hide`)}>
                    🙈
                  </button>
                  <button className="icon-btn" title="Неверно — убрать навсегда" onClick={() => act(`/facts/${fact.id}/reject`)}>
                    ❌
                  </button>
                </>,
              ),
            )}
          </Card>

          <div className="section-title">Добавить</div>
          <Card>
            <select className="select" value={kind} onChange={(event) => setKind(event.target.value)}>
              {MANUAL_KINDS.map((item) => (
                <option key={item} value={item}>
                  {FACT_LABELS[item]}
                </option>
              ))}
            </select>
            <div style={{ height: 8 }} />
            <input className="input" placeholder="Например: Rust" value={value} onChange={(event) => setValue(event.target.value)} />
            <button
              className="btn small"
              style={{ marginTop: 8 }}
              disabled={!value.trim()}
              onClick={async () => {
                await act("/me/facts", { kind, value });
                setValue("");
              }}
            >
              Добавить
            </button>
          </Card>

          {hidden.length > 0 && <div className="section-title">Скрытые</div>}
          {hidden.length > 0 && (
            <Card>
              {hidden.map((fact) =>
                factRow(
                  fact,
                  <button className="icon-btn" onClick={() => act(`/facts/${fact.id}/restore`)}>
                    ↩️
                  </button>,
                ),
              )}
            </Card>
          )}

          {pending.length > 0 && <div className="section-title">Летописец пока не уверен</div>}
          {pending.length > 0 && (
            <Card className="muted">
              {pending.map((fact) =>
                factRow(
                  fact,
                  <button className="icon-btn" onClick={() => act(`/facts/${fact.id}/reject`)}>
                    ❌
                  </button>,
                ),
              )}
              <div className="hint">Эти факты не видны другим, пока летописец не найдёт подтверждений.</div>
            </Card>
          )}
        </>
      )}

      <div className="section-title">Мои проекты</div>
      {data.projects.map((project) => (
        <Card key={project.id} onClick={() => go(`/p/${project.slug}`)}>
          <div className="name">
            {STATUS_EMOJI[project.status]} {project.name}
          </div>
        </Card>
      ))}
      <button className="btn secondary small" onClick={() => go("/projects")}>
        ＋ Добавить проект
      </button>

    </>
  );
}

// ---------- shell ----------

const TABS: [string, string, string][] = [
  ["/people", "👥", "Люди"],
  ["/projects", "🏆", "Проекты"],
  ["/chronicle", "📜", "Летопись"],
  ["/me", "👤", "Я"],
];

export function App() {
  const [route, go] = useRoute();
  useTelegramTheme();

  useEffect(() => {
    tg?.ready();
    tg?.expand();
    if (tg) document.documentElement.dataset.tg = "1";
    const start = routeFromStartParam(tg?.initDataUnsafe.start_param);
    if (start && !window.location.hash.startsWith("#/")) go(start);
  }, [go]);

  const [path] = route.split("?");
  const depth = path!.split("/").filter(Boolean).length;
  useEffect(() => {
    if (!tg) return;
    const back = () => window.history.back();
    if (depth > 1) {
      tg.BackButton.show();
      tg.BackButton.onClick(back);
    } else tg.BackButton.hide();
    return () => tg?.BackButton.offClick(back);
  }, [depth]);

  let screen: ReactNode;
  const [, section, param] = path!.split("/");
  if (section === "u" && param) screen = <PersonScreen id={param} go={go} />;
  else if (section === "p" && param) screen = <ProjectScreen slug={decodeURIComponent(param)} go={go} />;
  else if (section === "projects") screen = <ProjectsScreen go={go} />;
  else if (section === "chronicle") screen = <ChronicleScreen />;
  else if (section === "me") screen = <MeScreen go={go} />;
  else screen = <PeopleScreen go={go} />;

  const activeTab = section === "u" ? "/people" : section === "p" ? "/projects" : `/${section || "people"}`;
  return (
    <div className="app">
      <Backdrop />
      <div key={path}>{screen}</div>
      <nav className="tabs">
        {TABS.map(([to, icon, label]) => (
          <button
            key={to}
            className={`tab ${activeTab === to ? "active" : ""}`}
            onClick={() => {
              haptic();
              go(to);
            }}
          >
            <span>{icon}</span>
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}
