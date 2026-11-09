import { GrammyError, InlineKeyboard } from "grammy";
import { getChat } from "../core/chats.js";
import { chatNotes, deleteNote, type ListedNote, type NoteKind } from "../core/notes.js";
import { escapeHtml, truncate } from "../core/text.js";
import { findPersonByRef, getPerson, type Person } from "../core/users.js";
import { formatDate, userHeader } from "./format.js";
import { commandArgs, grid, type BotKit } from "./kit.js";

const LISTED = 30;
/** The list stays under Telegram's 4096 characters: notes that do not fit are left out, with their buttons. */
const LIST_CHARS = 3500;
const VALUE_CHARS = 160;

const KIND_LABELS: Record<NoteKind, string> = {
  correction: "✏️ correction",
  claim: "📣 claim",
  stance: "🧭 stance",
  bit: "🃏 running joke",
  bout: "🥊 bout",
  bait: "🎣 bait",
  about_bot: "🐝 about the bot",
  prediction: "🔮 prediction",
};

/**
 * /notes: what only the bot and its owners see (src/core/notes.ts), for an owner to look through and delete. The list
 * never shows in a group: asked there, it goes to the owner's DM.
 */
export function registerNotes(kit: BotKit): void {
  const { bot, sql, config } = kit;

  async function render(chatId: number, person: Person | undefined): Promise<{ html: string; keyboard: InlineKeyboard }> {
    const [chat, { notes, total }] = await Promise.all([getChat(sql, chatId), chatNotes(sql, chatId, { userId: person?.id, limit: LISTED })]);
    const names = new Map(
      (await sql<{ id: number; display_name: string }[]>`SELECT id, display_name FROM users WHERE id = ANY(${[...new Set(notes.flatMap((note) => note.user_ids))]}::int[])`).map(
        (user) => [user.id, user.display_name],
      ),
    );
    const title = `🗒 <b>Private notes</b> · ${escapeHtml(chat?.title ?? String(chatId))}${person ? ` · ${userHeader(person)}` : ""}`;
    if (total === 0) return { html: `${title}\n\nNothing noted yet.`, keyboard: new InlineKeyboard() };

    const shown: ListedNote[] = [];
    const lines: string[] = [];
    let room = LIST_CHARS;
    for (const note of notes) {
      const entry = noteEntry(note, shown.length + 1, names);
      if (entry.length > room) break;
      room -= entry.length;
      lines.push(entry);
      shown.push(note);
    }
    const more = total - shown.length;
    const html = [
      title,
      "Only bot owners see these; the bot uses them in its answers. Newest first; 🗑 deletes a note with its earlier versions.",
      "",
      ...lines,
      more > 0 ? `\n…and ${more} more${person ? "" : ": /notes @username narrows the list"}` : "",
    ]
      .filter((part) => part !== "")
      .join("\n");
    const filter = person ? `:${person.id}` : "";
    return { html, keyboard: grid(shown.map((note, index) => InlineKeyboard.text(`🗑 ${index + 1}`, `notedel:${note.id}${filter}`)), 5) };
  }

  function noteEntry(note: ListedNote, number: number, names: Map<number, string>): string {
    const others = note.user_ids.filter((id) => id !== note.user_id).flatMap((id) => (names.has(id) ? [escapeHtml(names.get(id)!)] : []));
    const who = [note.user_id !== null ? `<b>${escapeHtml(note.display_name ?? "?")}</b>` : "", ...others].filter(Boolean).join(", ") || "the chat";
    const state = [note.status, note.due_at ? `due ${formatDate(note.due_at, "UTC", false)}` : ""].filter(Boolean).join(", ");
    const head = [`${number}. ${KIND_LABELS[note.kind]}`, who, formatDate(note.said_at ?? note.created_at, config.DISPLAY_TIMEZONE, false), state].filter(Boolean).join(" · ");
    const about = note.about ? `<i>${escapeHtml(truncate(note.about, 60))}:</i> ` : "";
    return `${head}\n${about}${escapeHtml(truncate(note.value, VALUE_CHARS))}`;
  }

  bot.command("notes", async (ctx) => {
    if (!ctx.from) return;
    const owner = await kit.identity(ctx.from);
    if (!kit.isOwner(owner)) return;
    const scope = await kit.scope(ctx);
    if (!scope) return;
    const ref = commandArgs(ctx);
    const person = ref ? await findPersonByRef(sql, scope.chatId, ref) : undefined;
    if (ref && !person) return void (await kit.show(ctx, `I don't know who “${escapeHtml(ref)}” is in this chat. All members — /people`));
    const { html, keyboard } = await render(scope.chatId, person);
    if (kit.isPrivate(ctx)) return void (await kit.show(ctx, html, keyboard));
    try {
      await ctx.api.sendMessage(owner.tg_id!, html, { parse_mode: "HTML", reply_markup: keyboard, link_preview_options: { is_disabled: true } });
      await ctx.react("👌").catch(() => {});
    } catch (error) {
      if (!(error instanceof GrammyError && error.error_code === 403)) throw error;
      await sql`UPDATE users SET dm_started = false WHERE id = ${owner.id}`;
      await kit.show(ctx, "The notes go to your DM, and I can't message you there yet — open the bot 👇", new InlineKeyboard().url("Open the bot", `https://t.me/${bot.botInfo.username}`));
    }
  });

  bot.callbackQuery(/^notedel:(\d+)(?::(\d+))?$/, async (ctx) => {
    const owner = await kit.identity(ctx.from);
    if (!kit.isOwner(owner) || !kit.isPrivate(ctx)) return ctx.answerCallbackQuery({ text: "That's up to the bot owner" });
    const deleted = await deleteNote(sql, Number(ctx.match[1]));
    await ctx.answerCallbackQuery({ text: deleted ? "Deleted" : "It's gone already" });
    if (!deleted) return;
    const person = ctx.match[2] ? await getPerson(sql, deleted.chat_id, Number(ctx.match[2])) : undefined;
    const { html, keyboard } = await render(deleted.chat_id, person);
    await kit.show(ctx, html, keyboard, { edit: true });
  });
}
