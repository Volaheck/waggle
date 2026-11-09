import { addAlias, chatAliases, deleteAliases, MAX_ALIAS_LENGTH, type AddAliasOutcome, type AliasSource, type NamedAlias } from "../core/aliases.js";
import { getProjectBySlug } from "../core/projects.js";
import { escapeHtml } from "../core/text.js";
import { SERVICE_TG_IDS } from "../core/users.js";
import { commandArgs, type BotKit } from "./kit.js";

const USAGE = [
  "🏷 Tell me what the chat calls someone:",
  "/alias me Name — you",
  "/alias @username Name — a member (bot owners)",
  "/alias #project Name — a project (its authors and bot owners)",
  "/unalias Name removes a name, /aliases lists them all.",
].join("\n");

const SOURCE_LABELS: Record<AliasSource, { person: string; project: string }> = {
  owner: { person: "set by an owner", project: "set by an owner" },
  person: { person: "their own", project: "set by an author" },
  chronicler: { person: "noticed by the chronicler", project: "noticed by the chronicler" },
};

function targetName(alias: NamedAlias): string {
  return alias.user_id !== null ? `<b>${escapeHtml(alias.display_name ?? "?")}</b>` : `the project <b>${escapeHtml(alias.project_name ?? "?")}</b>`;
}

/** Names the chat uses for its members and projects, set by hand; the answer context resolves names with them. */
export function registerAliases(kit: BotKit): void {
  const { bot, sql } = kit;

  bot.command("alias", async (ctx) => {
    const scope = await kit.scope(ctx);
    if (!scope) return;
    const match = /^(me|@\w+|#[\w-]+)\s+(.+)$/isu.exec(commandArgs(ctx));
    if (!match) return void (await kit.show(ctx, USAGE));
    const target = match[1]!;
    const name = match[2]!;
    const owner = kit.isOwner(scope.user);
    const label = escapeHtml(name.replace(/\s+/g, " ").trim());
    const say = (outcome: AddAliasOutcome, who: string, self: boolean) =>
      kit.show(
        ctx,
        {
          added: `✅ “${label}” means ${who} now. All names — /aliases`,
          exists: `“${label}” already means ${who}.`,
          invalid: `A name needs a letter or a digit and at most ${MAX_ALIAS_LENGTH} characters.`,
          forbidden: "That name touches a topic I never keep (health, money, private life and the like), so I won't save it.",
          opted_out: self
            ? "You asked me not to collect anything about you here; turn that off in /me → 🔒 Privacy first."
            : `${who} asked me not to collect anything about them, so I keep no names for them.`,
        }[outcome],
      );

    if (target.startsWith("#")) {
      const project = await getProjectBySlug(sql, scope.chatId, target.slice(1).toLowerCase());
      if (!project) return void (await kit.show(ctx, `No project ${escapeHtml(target)} here. The list — /projects`));
      if (!owner && !project.authors.some((author) => author.id === scope.user.id)) {
        return void (await kit.show(ctx, `Only the authors of <b>${escapeHtml(project.name)}</b> or a bot owner can name it.`));
      }
      const outcome = await addAlias(sql, { chatId: scope.chatId, target: { projectId: project.id }, alias: name, source: owner ? "owner" : "person" });
      return void (await say(outcome, `the project <b>${escapeHtml(project.name)}</b>`, false));
    }

    let person: { id: number; display_name: string } | undefined = scope.user;
    if (target.startsWith("@")) {
      [person] = await sql<{ id: number; display_name: string }[]>`
        SELECT u.id, u.display_name FROM users u JOIN members m ON m.user_id = u.id
        WHERE m.chat_id = ${scope.chatId} AND m.left_at IS NULL AND lower(u.username) = lower(${target.slice(1)})
          AND (u.tg_id IS NULL OR u.tg_id <> ALL(${SERVICE_TG_IDS}::bigint[]))`;
      if (!person) return void (await kit.show(ctx, `I haven't seen ${escapeHtml(target)} in this chat yet: people show up here once they write or join.`));
    }
    const self = person.id === scope.user.id;
    if (!self && !owner) return void (await kit.show(ctx, "Only a bot owner names other people. For yourself: /alias me Name"));
    const outcome = await addAlias(sql, { chatId: scope.chatId, target: { userId: person.id }, alias: name, source: self ? "person" : "owner" });
    await say(outcome, self ? "you" : `<b>${escapeHtml(person.display_name)}</b>`, self);
  });

  bot.command("unalias", async (ctx) => {
    const scope = await kit.scope(ctx);
    if (!scope) return;
    const name = commandArgs(ctx);
    if (!name) return void (await kit.show(ctx, "Which name? /unalias Name — they are listed in /aliases"));
    const label = escapeHtml(name.replace(/\s+/g, " "));
    const found = await chatAliases(sql, scope.chatId, { alias: name });
    if (found.length === 0) return void (await kit.show(ctx, `Nobody is called “${label}” here. All names — /aliases`));
    const authored = new Set(
      (await sql<{ project_id: number }[]>`SELECT project_id FROM project_members WHERE user_id = ${scope.user.id}`).map((row) => row.project_id),
    );
    // A bot owner removes any name; anyone else the names of themselves and of their own projects.
    const removable = found.filter(
      (alias) => kit.isOwner(scope.user) || alias.user_id === scope.user.id || (alias.project_id !== null && authored.has(alias.project_id)),
    );
    if (removable.length === 0) return void (await kit.show(ctx, `Only a bot owner or whoever “${label}” names can remove it.`));
    await deleteAliases(sql, removable.map((alias) => alias.id));
    await kit.show(ctx, `Removed “${label}” for ${removable.map(targetName).join(", ")}.`);
  });

  bot.command("aliases", async (ctx) => {
    const scope = await kit.scope(ctx);
    if (!scope) return;
    const aliases = await chatAliases(sql, scope.chatId);
    if (aliases.length === 0) return void (await kit.show(ctx, "No names saved here yet. Add yours: /alias me Name"));
    const byTarget = new Map<string, NamedAlias[]>();
    for (const alias of aliases) {
      const key = alias.user_id !== null ? `u${alias.user_id}` : `p${alias.project_id}`;
      byTarget.set(key, [...(byTarget.get(key) ?? []), alias]);
    }
    const lines = [...byTarget.values()].map((group) => {
      const [first] = group as [NamedAlias];
      const whom =
        first.user_id !== null
          ? `<b>${escapeHtml(first.display_name ?? "?")}</b>${first.username ? ` @${escapeHtml(first.username)}` : ""}`
          : `<b>${escapeHtml(first.project_name ?? "?")}</b> #${escapeHtml(first.project_slug ?? "")}`;
      const names = group.map((alias) => `${escapeHtml(alias.alias)} <i>(${SOURCE_LABELS[alias.source][alias.user_id !== null ? "person" : "project"]})</i>`);
      return `• ${whom} — ${names.join(", ")}`;
    });
    await kit.show(ctx, ["🏷 <b>What people and projects are called here</b>", "", ...lines].join("\n"));
  });
}
