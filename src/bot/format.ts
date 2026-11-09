import { FACT_KIND_LABELS, type Fact, type FactKind } from "../core/facts.js";
import { STATUS_LABELS, type Project, type ProjectListItem } from "../core/projects.js";
import type { CatchupData, ChronicleEntry } from "../core/chronicle.js";
import { escapeHtml, messageLink, truncate } from "../core/text.js";
import type { Person, User } from "../core/users.js";

export const STATUS_EMOJI: Record<string, string> = {
  идея: "💡",
  "в работе": "🛠",
  запущен: "🚀",
  "на паузе": "⏸",
  заброшен: "🪦",
};

const TOPIC_EMOJI: Record<ChronicleEntry["kind"], string> = { discussion: "💬", project: "🛠", link: "🔗", news: "📰" };

const SIGNAL_EMOJI: Record<string, string> = { praise: "❤️", critique: "🧐", usage: "✅", contribution: "🤝", interest: "👀", milestone: "🚀" };

/** «3 messages», «1 card». */
export function countOf(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function formatDate(date: Date, timeZone: string, withTime = true): string {
  return date.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
    timeZone,
  });
}

function groupFacts(facts: Fact[]): Map<FactKind, Fact[]> {
  const grouped = new Map<FactKind, Fact[]>();
  for (const fact of facts) grouped.set(fact.kind, [...(grouped.get(fact.kind) ?? []), fact]);
  return grouped;
}

export function userHeader(user: Pick<User, "display_name" | "username">): string {
  return `<b>${escapeHtml(user.display_name)}</b>${user.username ? ` @${escapeHtml(user.username)}` : ""}`;
}

export function personCard(user: Pick<Person, "display_name" | "username" | "tagline" | "opted_out">, facts: Fact[], projects: Project[], options: { compact?: boolean } = {}): string {
  const lines = [userHeader(user)];
  if (user.opted_out) {
    lines.push("<i>Opted out of data collection.</i>");
    return lines.join("\n");
  }
  if (user.tagline) lines.push(`<i>${escapeHtml(user.tagline)}</i>`);
  const grouped = groupFacts(facts.filter((fact) => fact.kind !== "project"));
  const limit = options.compact ? 4 : 12;
  for (const [kind, items] of grouped) {
    lines.push(`${FACT_KIND_LABELS[kind]}: ${items.slice(0, limit).map((fact) => escapeHtml(fact.value)).join(", ")}`);
  }
  const catalogNames = projects.map((project) => project.name.toLowerCase());
  const extraProjectFacts = facts
    .filter((fact) => fact.kind === "project" && !catalogNames.some((name) => fact.value.toLowerCase().includes(name)))
    .map((fact) => escapeHtml(fact.value));
  const allProjects = [...projects.map((project) => `${STATUS_EMOJI[project.status] ?? ""}${escapeHtml(project.name)}`), ...extraProjectFacts];
  if (allProjects.length) lines.push(`Projects: ${allProjects.slice(0, options.compact ? 4 : 10).join(", ")}`);
  if (lines.length === 1) lines.push("<i>Nothing known yet.</i>");
  return lines.join("\n");
}

export function projectLine(project: ProjectListItem, index: number): string {
  const authors = project.authors.map((author) => escapeHtml(author.display_name)).join(", ");
  const tagline = project.tagline ? ` — ${escapeHtml(truncate(project.tagline, 80))}` : "";
  return `${index}. ${STATUS_EMOJI[project.status] ?? ""} <b>${escapeHtml(project.name)}</b> · 🏆${project.score}${tagline}${authors ? ` <i>(${authors})</i>` : ""}`;
}

export function projectCard(project: ProjectListItem, chatId: number): string {
  const lines = [`${STATUS_EMOJI[project.status] ?? ""} <b>${escapeHtml(project.name)}</b> · ${escapeHtml(STATUS_LABELS[project.status] ?? project.status)}`];
  if (project.tagline) lines.push(escapeHtml(project.tagline));
  if (project.authors.length) {
    lines.push(`Authors: ${project.authors.map((author) => `${escapeHtml(author.display_name)}${author.role ? ` <i>(${escapeHtml(author.role)})</i>` : ""}`).join(", ")}`);
  }
  if (project.stack.length) lines.push(`Stack: ${project.stack.map(escapeHtml).join(", ")}`);
  const links = [project.links.repo, project.links.site, ...(project.links.other ?? [])].filter((link): link is string => Boolean(link));
  if (links.length) lines.push(links.map((link) => `<a href="${escapeHtml(link)}">${escapeHtml(link.replace(/^https?:\/\//, ""))}</a>`).join(" · "));
  lines.push(`🏆 Rating ${project.score} · 👍 ${project.votes}`);
  if (project.recent_signals.length) {
    lines.push("", "<b>What people say</b>");
    for (const signal of project.recent_signals.slice(0, 4)) {
      const link = signal.msg_id ? ` <a href="${messageLink(chatId, signal.msg_id)}">→</a>` : "";
      lines.push(`${SIGNAL_EMOJI[signal.kind] ?? "•"} ${escapeHtml(signal.note)}${link}`);
    }
  }
  if (project.first_seen_msg_id) lines.push("", `<a href="${messageLink(chatId, project.first_seen_msg_id)}">First mention in the chat</a>`);
  return lines.join("\n");
}

export function factsWithSources(facts: Fact[], chatId: number): string {
  if (facts.length === 0) return "<i>Nothing.</i>";
  return facts
    .map((fact, index) => {
      const sources = fact.source_msg_ids.slice(0, 3).map((id, n) => `<a href="${messageLink(chatId, id)}">${n + 1}</a>`).join(" ");
      const flag = fact.status === "hidden" ? " 🙈" : fact.status === "manual" ? " ✍️" : "";
      return `${index + 1}. ${FACT_KIND_LABELS[fact.kind]}: ${escapeHtml(fact.value)}${flag}${sources ? ` <i>[${sources}]</i>` : ""}`;
    })
    .join("\n");
}

export function chronicleLine(entry: ChronicleEntry, chatId: number): string {
  const link = entry.msg_ids[0] ? ` <a href="${messageLink(chatId, entry.msg_ids[0])}">→</a>` : "";
  return `${TOPIC_EMOJI[entry.kind]} <b>${escapeHtml(entry.title)}</b>${link}\n${escapeHtml(entry.summary)}`;
}

export function catchupHtml(data: CatchupData, users: Map<number, User>, chatId: number, intervalHours: number, timeZone: string): string {
  const header = `<b>While you were away</b> · since ${formatDate(data.from, timeZone)}, ${countOf(data.totalMessages, "message")}`;
  if (data.totalMessages === 0) return `${header}\n\nIt was quiet in the chat 🍵`;
  const lines = [header, ""];
  if (data.entries.length) {
    for (const entry of data.entries) lines.push(chronicleLine(entry, chatId), "");
  } else {
    lines.push("<i>The chronicle for this period isn't ready yet.</i>", "");
  }
  if (data.unprocessed.count > 0 && data.unprocessed.firstMsgId) {
    lines.push(
      `⏳ ${countOf(data.unprocessed.count, "more message", "more messages")} not chronicled yet (the chronicler goes through new ones every ${intervalHours} h) — <a href="${messageLink(chatId, data.unprocessed.firstMsgId)}">read from here</a>.`,
    );
  }
  if (data.mentions.length) {
    const links = data.mentions
      .slice(0, 6)
      .map((message, index) => {
        const author = message.user_id ? users.get(message.user_id)?.display_name ?? "?" : "?";
        return `<a href="${messageLink(chatId, message.msg_id)}">${index + 1}. ${escapeHtml(author)}</a>`;
      })
      .join(" · ");
    lines.push(`💬 You were mentioned: ${links}`);
  }
  return lines.join("\n").trim();
}

export function clampTelegram(html: string, max = 3900): string {
  if (html.length <= max) return html;
  const cut = html.slice(0, max);
  const lastBreak = cut.lastIndexOf("\n");
  if (lastBreak > 0) return `${cut.slice(0, lastBreak)}\n…`;
  return `${cut.replace(/<[^>]*>?/g, "").replace(/&[a-z#0-9]*$/i, "")}…`;
}
