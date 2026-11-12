import type { Fragment } from "postgres";
import type { Queryable } from "./db.js";

/**
 * Wishes: a member asks the bot not to write something, or not to write in some way, and it keeps to that from then on
 * (migrations/016_wishes.sql). One for themselves is about how it writes to them or about them («не шути про мой вес»,
 * «пиши мне короче»); one for the whole chat, which only the chat's Telegram admins and the bot's owners ask for, or take
 * back, is about what it writes there at all («не пиши в этом чате про политику»). The card requests read them
 * (src/bot/self-edits.ts) and write them under the self-edit role (src/core/own-card.ts); the answers, the interjections
 * and the weekly idea are given the ones that bear on them. A wish only ever narrows what the bot writes.
 */

export const WISH_SCOPES = ["self", "chat"] as const;
export type WishScope = (typeof WISH_SCOPES)[number];

export const MAX_WISH_CHARS = 300;
/** Wishes a member keeps for themselves in a chat. */
export const MAX_OWN_WISHES = 20;
/** Wishes a chat keeps for everyone in it. */
export const MAX_CHAT_WISHES = 30;

export interface Wish {
  id: number;
  user_id: number;
  scope: WishScope;
  text: string;
  created_at: Date;
}

/** A wish with the name of whoever asked for it. */
export interface NamedWish extends Wish {
  display_name: string;
}

/** The chat's wishes for everyone, and each member's own, by member. */
export interface ChatWishes {
  chat: NamedWish[];
  own: Map<number, NamedWish[]>;
}

/** Two wordings are one wish when they differ only in case, «ё», spacing and punctuation. */
export function wishKey(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The apostrophes phones type («don’t») read as the plain one. */
export const plainApostrophes = (text: string) => text.replace(/[’ʼ‘`´]/g, "'");

/** The words of a wish, lowercased, «ё» as «е», «don’t» as «dont». */
export function wishWords(text: string): string[] {
  return (plainApostrophes(text).normalize("NFKC").toLowerCase().replace(/ё/g, "е").match(/[\p{L}\p{N}']+/gu) ?? []).map((word) => word.replace(/'/g, ""));
}

/** Every wish a member asked for in a chat, for themselves and for the whole chat, oldest first. */
export async function ownWishes(sql: Queryable, chatId: number, userId: number): Promise<Wish[]> {
  return sql<Wish[]>`
    SELECT id, user_id, scope, text, created_at FROM wishes WHERE chat_id = ${chatId} AND user_id = ${userId} ORDER BY created_at, id`;
}

/**
 * The wishes a member's request may name: their own, and the chat's wishes for everyone that others asked for, which a
 * chat's admin or a bot owner may take back.
 */
export async function wishesOnCard(sql: Queryable, chatId: number, userId: number): Promise<{ own: Wish[]; chat: Wish[] }> {
  const rows = await sql<Wish[]>`
    SELECT id, user_id, scope, text, created_at FROM wishes
    WHERE chat_id = ${chatId} AND (user_id = ${userId} OR scope = 'chat')
    ORDER BY created_at, id`;
  return { own: rows.filter((wish) => wish.user_id === userId), chat: rows.filter((wish) => wish.user_id !== userId) };
}

/** Every wish a chat keeps: its wishes for everyone, and each member's own, oldest first, with who asked for each. */
export async function wishesOfChat(sql: Queryable, chatId: number): Promise<ChatWishes> {
  const rows = await sql<NamedWish[]>`
    SELECT w.id, w.user_id, w.scope, w.text, w.created_at, u.display_name
    FROM wishes w JOIN users u ON u.id = w.user_id
    WHERE w.chat_id = ${chatId}
    ORDER BY w.created_at, w.id`;
  const own = new Map<number, NamedWish[]>();
  for (const wish of rows) if (wish.scope === "self") own.set(wish.user_id, [...(own.get(wish.user_id) ?? []), wish]);
  return { chat: rows.filter((wish) => wish.scope === "chat"), own };
}

/** The chat's wishes for everyone, oldest first, with who asked for each. */
export async function chatWishes(sql: Queryable, chatId: number): Promise<NamedWish[]> {
  return sql<NamedWish[]>`
    SELECT w.id, w.user_id, w.scope, w.text, w.created_at, u.display_name
    FROM wishes w JOIN users u ON u.id = w.user_id
    WHERE w.chat_id = ${chatId} AND w.scope = 'chat'
    ORDER BY w.created_at, w.id`;
}

/** A clause ends at punctuation and at «и», «а», «но», "and", "but": a negation reaches no further. */
const CLAUSE_BREAK = /[.,;:!?…()[\]{}"«»„“”\n—–]+|\s-\s|(?<!\p{L})(?:и|а|но|или|либо|and|but|or)(?!\p{L})/iu;
/** Words that negate what follows them in their clause. */
const NEGATORS = new Set(["не", "нет", "без", "хватит", "перестань", "перестаньте", "прекрати", "прекратите", "завязывай", "not", "no", "dont", "doesnt", "never", "stop", "quit", "without"]);
/** «Никогда», «никому» and the like negate only together with «не», which then is one negation, not two. */
const CONCORD = /^(?:ни|никогда|никому|ничего|ничем|ничему|никого|никем|нигде|никуда|никак|ни\p{L}+)$/u;
/** «Без» before these says when, not what to leave out: «не пиши про меня без моего разрешения» negates once. */
const CONDITION = /^(?:разрешени|спрос|согласи|просьб|повод|причин|нужд|необходимост|дела|приглашени|permission|consent|asking|reason|need|invitation|being)/u;
const POSSESSIVE = new Set(["моего", "моей", "моих", "my", "a", "an", "any"]);
/** After these, what is left of a clause is no longer negated: «ничего, кроме комплиментов». */
const EXCEPT = new Set(["кроме", "только", "лишь", "except", "only"]);

/** The bot's own rules and prompt: no wish touches them. */
const RULES = /^(?:правило|правила|правил|правилам|правилами|правилах|инструкци\p{L}*|промпт\p{L}*|rules?|instructions?|prompts?|guardrails?|jailbreak\p{L}*)$/u;
/** The bot's limits, refusals, silence and brevity: a wish that takes one away («не отказывай мне», «не молчи») loosens it. */
const LIMITS =
  /^(?:отказ|откаж|огранич|фильтр|цензур|скрыв|скрыт|утаив|утаи|сдержив|стесня|маскир|молч|умалч|игнор|пропуска|меньш|короч|корот|кратк|реже|refus|limit|restrict|filter|censor|hid(?:e|es|ing|den)?$|mask(?:s|ing|ed)?$|hold(?:s|ing)?$|silen|quiet|ignor|skip|less$|fewer$|short(?:er|ly)?$|brief(?:ly|er)?$|rarely$|seldom$)/u;
/** Keeping something from the asker: «не держи от меня секретов», "don't keep anything from me". */
const KEEPING = /^(?:держ|прят|храни|keep|kept)/u;
/** Agreeing and praising: asked for plainly («хвали меня», "always agree with me"), a wish would make the bot do more. */
const AGREEING = /^(?:соглаш|соглас|поддак|хвал|похвал|льст|лест|восхвал|комплимент|agree|prais|flatter|compliment)/u;
/** Writing more, more often, in more detail, with links or ads, or telling more: not what a wish asks of the bot. */
const MORE =
  /^(?:подробн|развернут|длинн|чаще|ссылк|реклам|промо|рассказыва|расскаж|раскрыва|раскро|выдава|выда[йт]|слива|слей|показыва|покаж|more|longer|detail|often|links?$|advert|promo|reveal|disclos|tell|show|share|leak)/u;
/** Asking for something every time, or for mentions: more, unless the same clause narrows it («упоминай меня реже»). */
const UNLESS_NARROWED = /^(?:всегда|кажд\p{L}*|упомина\p{L}*|упомян\p{L}*|т[еэ]га\p{L}*|пингу\p{L}*|always|every\w*|mention\w*|tag\w*|ping\w*)$/u;
/** What makes a wish narrow what the bot writes: a word that says no, without or stop, or a narrower manner. */
const NARROWING =
  /(?<!\p{L})(?:не|ни|нет|никогда|никому|ничего|хватит|перестань(?:те)?|прекрати(?:те)?|завязывай|без|только|лишь|короче|покороче|кратко|кратче|проще|попроще|меньше|реже|вежлив\p{L}*|спокойн\p{L}*|по-русски|по-английски|на\s+(?:русском|английском|«?вы»?|«?ты»?))(?!\p{L})|\b(?:not|no|never|don'?t|doesn'?t|stop|quit|without|only|shorter|brief\w*|simpl\w*|less|fewer|polite\w*|formal\w*|in\s+(?:english|russian))\b/iu;

/**
 * Whether a wish would loosen the bot rather than narrow it. It touches the bot's rules or prompt; takes away a limit, a
 * refusal or its silence («не отказывай мне», «не молчи», «не скрывай»); keeps nothing from the asker; negates twice
 * («не пиши без ссылки» asks for the link); asks it to agree, praise, tell or write more («хвали меня», «пиши
 * подробнее»); or says nothing that narrows at all («пиши обо мне со ссылкой на мой канал»). «не хвали меня» narrows.
 */
export function loosens(text: string): boolean {
  const plain = plainApostrophes(text);
  if (!NARROWING.test(plain)) return true;
  return plain.split(CLAUSE_BREAK).some((clause = "") => {
    // A name they go by carries no meaning here: «не называй меня Шорти», «Молчуном».
    const names = new Set((clause.match(/(?<=\S\s+)\p{Lu}[\p{L}'’]*/gu) ?? []).flatMap(wishWords));
    const words = wishWords(clause);
    const narrowed = NARROWING.test(clause);
    let negated = false;
    let concord = false;
    return words.some((word, index) => {
      if (RULES.test(word)) return true;
      if (names.has(word)) return false;
      if (EXCEPT.has(word)) {
        negated = false;
        return false;
      }
      if (CONCORD.test(word)) {
        concord = true;
        return false;
      }
      const next = POSSESSIVE.has(words[index + 1] ?? "") ? words[index + 2] : words[index + 1];
      if ((word === "без" || word === "without") && CONDITION.test(next ?? "")) return false;
      if (NEGATORS.has(word)) {
        // A second negation in the clause takes the first back, «никогда не» aside: «не пиши без ссылки».
        const twice = negated && !(concord && word === "не");
        negated = true;
        return twice;
      }
      // «больше не шути» is a stop: its «больше» asks for nothing more.
      if (word === "больше" && (NEGATORS.has(words[index + 1] ?? "") || CONCORD.test(words[index + 1] ?? ""))) return false;
      if (negated) return LIMITS.test(word) || (KEEPING.test(word) && /(?<!\p{L})(?:от\s+меня|from\s+me)(?!\p{L})/iu.test(clause));
      return AGREEING.test(word) || MORE.test(word) || word === "больше" || (!narrowed && UNLESS_NARROWED.test(word));
    });
  });
}

/** Speaking up in a conversation one is not part of, as a request names it. */
const KEEP_OUT =
  /^(?:встрева(?:й|йте|ть)|встрять|вмешива(?:йся|йтесь|ться)|вмеша(?:йся|йтесь|ться)|влеза(?:й|йте|ть)|влезть|лез(?:ь|ьте|ть)|вклинива(?:йся|йтесь|ться)|вклини(?:сь|тесь|ться)|перебива(?:й|йте|ть)|interject\w*|interrupt\w*)$/u;
/** "butt in", "chime in", "jump in", "cut in", "barge in": the verb, before its «in». */
const BUTTING = /^(?:butt|chim|jump|cut|barg)\w*$/u;
/** Answering or writing keeps the bot out only of the conversations a wish names: «не отвечай в моих разговорах». */
const SPEAKING = /^(?:отвеча(?:й|йте|ть)|пиш(?:и|ите)|писать|комментиру(?:й|йте)|комментировать|repl\w*|answer\w*|writ\w*|comment\w*)$/u;
const CONVERSATION = /^(?:разговор|бесед|спор|обсуждени|дискусси|переписк|болтовн|чат|conversation|chat|discussion|argument|talk|thread)/u;
const STOPPING = new Set(["не", "хватит", "перестань", "перестаньте", "прекрати", "прекратите", "завязывай", "dont", "never", "stop", "quit", "no"]);
/** What may stand around such a verb in a wish to keep out: whose conversations, when, and words of asking. */
const AROUND = new Set([
  "в", "во", "мои", "моих", "мой", "моем", "моём", "наши", "наших", "наш", "чужие", "чужих", "меня", "нас", "мне", "без", "спроса", "приглашения", "когда", "не",
  "просят", "зовут", "тут", "здесь", "больше", "никогда", "пожалуйста", "плиз", "please", "pls", "my", "our", "in", "into", "on", "of", "the", "me", "us",
  "uninvited", "unasked", "ever", "again", "anymore", "unless", "asked", "called", "here", "people", "others",
]);
/** A topic after what it keeps out of: «не влезай в споры про политику» is about politics, not about speaking up. */
const TOPIC = new Set(["про", "о", "об", "обо", "насчет", "насчёт", "тему", "about", "regarding", "re"]);

/**
 * Whether a wish keeps the bot out of its asker's conversations, or of all of them: «не встревай в мои разговоры»,
 * «хватит вклиниваться в наши споры», «не отвечай в моих разговорах», "don't butt in", "stay out of my conversations".
 * One about a topic or anything else is a wish like any other: «не влезай в споры про политику», «не лезь в мою личную
 * жизнь», «не лезь ко мне с советами».
 */
export function keepsOut(text: string): boolean {
  return plainApostrophes(text)
    .split(/[.;:!?…\n]+|,\s*(?=(?:когда|если|пока|unless|when|if)(?![\p{L}]))/iu)
    .some((clause) => {
      const words = wishWords(clause);
      if (words.some((word) => TOPIC.has(word))) return false;
      const stop = words.findIndex((word) => STOPPING.has(word));
      const verb = words.findIndex((word, index) => {
        if ((word === "stay" || word === "keep") && words[index + 1] === "out") return true;
        if (stop < 0 || index <= stop || index - stop > 4) return false;
        return KEEP_OUT.test(word) || (BUTTING.test(word) && /^in(?:to)?$/u.test(words[index + 1] ?? "")) || (SPEAKING.test(word) && words.slice(index + 1).some((next) => CONVERSATION.test(next)));
      });
      if (verb < 0) return false;
      const after = words.slice(verb + 1).filter((word, index) => !(index === 0 && /^(?:in|into|out)$/u.test(word)));
      return after.every((word) => AROUND.has(word) || CONVERSATION.test(word));
    });
}

/**
 * Moves a chat's wishes to another chat id (a supergroup upgrade). `sourceIds` maps a message id the way the messages
 * moved. A wish the new id already has absorbs the moving copy (one for everyone, whoever asked for it), and none stays
 * of a member who opted out on either side.
 */
export async function moveWishes(tx: Queryable, from: number, to: number, sourceIds: (column: string) => Fragment): Promise<void> {
  const moving = await tx<{ id: number; user_id: number; scope: WishScope; text: string }[]>`SELECT id, user_id, scope, text FROM wishes WHERE chat_id = ${from}`;
  const kept = await tx<{ user_id: number; scope: WishScope; text: string }[]>`SELECT user_id, scope, text FROM wishes WHERE chat_id = ${to}`;
  const keyOf = (wish: { user_id: number; scope: WishScope; text: string }) => `${wish.scope === "chat" ? "chat" : wish.user_id}:${wishKey(wish.text)}`;
  const keys = new Set(kept.map(keyOf));
  const twins = moving.filter((wish) => keys.has(keyOf(wish))).map((wish) => wish.id);
  if (twins.length) await tx`DELETE FROM wishes WHERE id = ANY(${twins}::bigint[])`;
  await tx`UPDATE wishes SET chat_id = ${to}, source_msg_id = ${sourceIds("source_msg_id")} WHERE chat_id = ${from}`;
  await tx`DELETE FROM wishes w USING members m WHERE w.chat_id = ${to} AND m.chat_id = ${to} AND m.user_id = w.user_id AND m.opted_out`;
}

/**
 * Linking a card to an account: the card's wishes become the account's (one the account already has absorbs the card's
 * copy, and so does a wish its chat keeps for everyone already), and an opt-out on either side wins.
 */
export async function moveWishesToUser(tx: Queryable, seedUserId: number, intoUserId: number): Promise<void> {
  const card = await tx<{ id: number; chat_id: number; scope: WishScope; text: string }[]>`SELECT id, chat_id, scope, text FROM wishes WHERE user_id = ${seedUserId}`;
  if (card.length === 0) return;
  const kept = await tx<{ chat_id: number; scope: WishScope; text: string }[]>`
    SELECT chat_id, scope, text FROM wishes
    WHERE chat_id = ANY(${[...new Set(card.map((wish) => wish.chat_id))]}::bigint[]) AND (user_id = ${intoUserId} OR (scope = 'chat' AND user_id <> ${seedUserId}))`;
  const keyOf = (wish: { chat_id: number; scope: WishScope; text: string }) => `${wish.chat_id}:${wish.scope}:${wishKey(wish.text)}`;
  const keys = new Set(kept.map(keyOf));
  const moved = card.filter((wish) => !keys.has(keyOf(wish))).map((wish) => wish.id);
  if (moved.length) await tx`UPDATE wishes SET user_id = ${intoUserId} WHERE id = ANY(${moved}::bigint[])`;
  await tx`DELETE FROM wishes WHERE user_id = ${seedUserId}`;
  await tx`DELETE FROM wishes w USING members m WHERE m.user_id = ${intoUserId} AND m.opted_out AND w.chat_id = m.chat_id AND w.user_id = ${intoUserId}`;
}
