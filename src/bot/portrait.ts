import { InlineKeyboard, type Bot } from "grammy";
import type { Config } from "../core/config.js";
import type { Sql } from "../core/db.js";
import { askRebuild, deletePortrait, observationCount, pausePortrait, portraitOf, startPortrait, type Portrait } from "../core/portrait.js";
import { portraitFooter, portraitMessages } from "../worker/portrait.js";
import { countOf, formatDate } from "./format.js";
import type { BotContext } from "./kit.js";

/** Each rewrite costs a call to the strongest model: not more often than this on request. */
const REBUILD_MIN_HOURS = 12;

export function portraitIntro(isOwner: boolean): string {
  return [
    "🪞 <b>A portrait of your character</b>",
    "",
    "I can read what you write and put together an honest portrait of who you are: how you think and feel, how you treat people, what drives you, your shadow side, and signs of neurodivergence (autism, ADHD) or of your mental state, if there are any. Signs, not diagnoses: a chat can't establish one. Nothing is softened.",
    "",
    "Where from: the groups I'm in, and your private chats if you connect me to your account (Settings → Telegram Business → Chat Automation; it needs Telegram Premium).",
    "",
    "• Only you see it, here. Not the groups, not the app, not the bot's owners in the bot.",
    "• Your messages, and the other side's in private chats, go to Claude (Anthropic) with phone numbers, emails and secrets masked. Their text is deleted once read; what stays is short observations with quotes of your own words, and the portrait.",
    isOwner
      ? "• It all lives in this bot's database on your server."
      : "• The bot runs on its operator's server: whoever runs it could technically read the database.",
    "• Pause or delete everything any time: /portrait.",
    "",
    "The first portrait comes once I've seen enough, usually after a few days of chatting.",
  ].join("\n");
}

const startButton = () => new InlineKeyboard().text("🪞 Start my portrait", "bzp:start");

function controls(portrait: Portrait): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (portrait.status === "on") {
    if (portrait.sections) keyboard.text("🔄 Rewrite with what's new", "bzp:rebuild");
    keyboard.text("⏸ Pause", "bzp:pause");
  } else {
    keyboard.text("▶️ Resume", "bzp:start");
  }
  return keyboard.row().text("🗑 Delete everything", "bzp:delete");
}

async function statusLine(sql: Sql, portrait: Portrait, timeZone: string): Promise<string> {
  const observations = await observationCount(sql, portrait.tg_id);
  const read = `${countOf(portrait.read_dm, "message")} of yours read in private chats, ${portrait.read_group} in groups; ${countOf(observations, "observation")}.`;
  const state =
    portrait.status === "paused"
      ? "⏸ Paused: I'm not reading anything new."
      : portrait.sections
        ? `Collecting. Last written ${portrait.written_at ? formatDate(portrait.written_at, timeZone, false) : "—"}; I rewrite it every few days when there's enough new.`
        : "Collecting. The first portrait comes once there's enough to say something true.";
  return `🪞 ${state}\n${read}`;
}

/**
 * /portrait and its buttons, for anyone, in their private chat with the bot only. Every action works on the person
 * pressing it, so nobody can see or change another person's portrait.
 */
export function registerPortrait(bot: Bot<BotContext>, deps: { sql: Sql; config: Config; on: boolean }): void {
  const { sql, config, on } = deps;
  const timeZone = config.DISPLAY_TIMEZONE;
  const isOwner = (tgId: number) => config.ADMIN_TG_IDS.includes(tgId);

  bot.command("portrait", async (ctx, next) => {
    if (ctx.chat.type !== "private" || !ctx.from) return next();
    if (!on) return ctx.reply("Portraits are off on this bot.");
    const portrait = await portraitOf(sql, ctx.from.id);
    if (!portrait) return ctx.reply(portraitIntro(isOwner(ctx.from.id)), { parse_mode: "HTML", reply_markup: startButton() });
    if (portrait.sections) {
      for (const text of portraitMessages(portrait.sections, portraitFooter(portrait, timeZone))) {
        await ctx.reply(text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
      }
    }
    await ctx.reply(await statusLine(sql, portrait, timeZone), { reply_markup: controls(portrait) });
  });

  bot.callbackQuery(/^bzp:(start|pause|rebuild|delete|delete:yes|delete:no)$/, async (ctx) => {
    const action = ctx.match[1];
    const tgId = ctx.from.id;
    if (ctx.chat?.type !== "private" || !on) return ctx.answerCallbackQuery({ text: on ? "Only in our private chat" : "Portraits are off" });
    const edit = (text: string, keyboard?: InlineKeyboard) => ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard }).catch(() => {});

    if (action === "start") {
      const created = await startPortrait(sql, tgId);
      await ctx.answerCallbackQuery({ text: created ? "Started" : "Resumed" });
      return edit(
        created
          ? "🪞 <b>Started.</b> I'm reading your messages from now on (and what the groups still keep from the last days). I'll send the first portrait here once there's enough. /portrait shows where it stands."
          : "▶️ <b>Resumed.</b> /portrait shows where it stands.",
      );
    }
    const portrait = await portraitOf(sql, tgId);
    if (!portrait) {
      await ctx.answerCallbackQuery({ text: "There's no portrait" });
      return edit("There's no portrait. /portrait to start one.");
    }
    if (action === "pause") {
      await pausePortrait(sql, tgId);
      await ctx.answerCallbackQuery({ text: "Paused" });
      const paused = (await portraitOf(sql, tgId))!;
      return edit(await statusLine(sql, paused, timeZone), controls(paused));
    }
    if (action === "rebuild") {
      if (portrait.status !== "on") return ctx.answerCallbackQuery({ text: "Resume it first" });
      if (portrait.written_at && Date.now() - portrait.written_at.getTime() < REBUILD_MIN_HOURS * 3_600_000) {
        return ctx.answerCallbackQuery({ text: `It was written less than ${REBUILD_MIN_HOURS} hours ago: try again later`, show_alert: true });
      }
      await askRebuild(sql, tgId);
      return ctx.answerCallbackQuery({ text: "I'll read what's waiting and rewrite it within a few minutes, if there's anything new", show_alert: true });
    }
    if (action === "delete") {
      await ctx.answerCallbackQuery();
      return edit(
        "🗑 Delete your portrait, every observation behind it and the messages not read yet? This can't be undone. (Message texts already read are gone anyway.)",
        new InlineKeyboard().text("Yes, delete everything", "bzp:delete:yes").text("Cancel", "bzp:delete:no"),
      );
    }
    if (action === "delete:no") {
      await ctx.answerCallbackQuery();
      return edit(await statusLine(sql, portrait, timeZone), controls(portrait));
    }
    await deletePortrait(sql, tgId);
    await ctx.answerCallbackQuery({ text: "Deleted" });
    return edit("🗑 Deleted: the portrait, the observations and the unread messages. I'm not collecting anything for it anymore. /portrait to start over.");
  });
}
