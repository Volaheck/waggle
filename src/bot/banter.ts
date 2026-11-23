import type { ReactionTypeEmoji } from "grammy/types";

/**
 * Lines to the bot that ask nothing of it. In five minutes one member got 19 answers, half of them to teasing, caps and
 * emoji, each from the stronger model (2026-11-23): a run of such lines now gets one short line from the base model, and
 * a message of nothing but emoji a reaction (assistant.ts). Both rules are deliberately narrow, since a real request
 * answered in a curt line costs more than a joke answered in full: a line is banter only by a sign of banter (a laugh,
 * emoji, capitals, a word to the bot, thanks, praise or a jab), and never with any sign of a question, a task or a
 * follow-up to one. A line with neither is answered in full: follow-ups to a task («перепиши на Go», «упрости», «на Go»,
 * «короче») share no word to look for, and taken for banter, the third of them would get a quip instead of the work.
 */

/** A question mark, a question word, or an English question's opening word. */
const QUESTION = new RegExp(
  [
    String.raw`[?¿？]`,
    String.raw`(?<![\p{L}\p{N}])(?:кто|кого|кому|кем|что|чего|чему|чем|как|как(?:ой|ая|ое|ие|их|им|ими|ую|ом|ого|ому|ов|ова|овы)|где|куда|откуда|когда|зачем|почему|отчего|сколько|ч(?:ей|ья|ьё|ье|ьи|ьих|ьим)|ли|разве|неужели)(?![\p{L}\p{N}])`,
    String.raw`\b(?:who|whom|whose|what|what's|whats|which|where|when|why|how)\b|\b(?:can|could|would|will) you\b`,
    String.raw`^[\s\p{P}]*(?:can|could|would|will|should|shall|is|are|am|was|were|do|does|did|have|has|may|might)\b`,
  ].join("|"),
  "iu",
);

/**
 * A task, a request or a follow-up to one: a stem of work wherever it stands in a word, so its prefixed forms count too
 * («напиши» and «перепиши», «делай» and «переделай», «упрости», «продолжай», «подробнее»), «можешь», «давай», «ещё»,
 * «теперь», «серьёзно», «задача», «пожалуйста», a line that opens on «а про…» or «и на…», and their English kin. A stem
 * found inside some other word only makes a line a full answer, which is the safe way to be wrong.
 */
const TASK = new RegExp(
  [
    String.raw`(?:пиш|писа|расскаж|рассказ|объясн|поясн|счита|прикин|перечисл|состав|придума|предлож|сравн|оцен|анализ|разбер|разбир|изуч|найд|найти|поищ|помог|помоч|покаж|показ|перевед|перевод|дела|генер|рису|подвед|итог|суммир|резюм|наброс|накида|назов|вспомн|провер|глян|посмотр|рассуд|ответ|скаж|напомн|добав|удал|убер|убра|помен|измен|замен|исправ|поправ|почин|реш|проектир|продума|упрост|сократ|улучш|оптимиз|рефактор|допол|расшир|доработ|переработ|продолж|подробн|детальн|разверн|уточн|обнов|повтор|переформулир|перефраз|встав|серь[её]зн|задач)`,
    String.raw`(?<![\p{L}\p{N}])(?:можешь|можете|сможешь|умеешь|нужн\p{L}*|надо|дай|дайте|давай|давайте|ещ[её]|дальше|больше|теперь|пожалуйста|пжлст|плиз|плз)(?![\p{L}\p{N}])`,
    String.raw`^[\s\p{P}]*(?:ну\s+)?(?:а|и)\s+(?:про|о|об|обо|насч[её]т|теперь|если|с|со|без|для|на|в|во|под|через|ещ[её])(?![\p{L}\p{N}])`,
    String.raw`\b(?:write|rewrite|explain|tell|list|compare|analy[sz]e|plan|count|estimate|calculate|summari[sz]e|find|show|help|suggest|propose|review|check|translate|describe|give|name|make|build|draft|recommend|fix|debug|solve|design|please|pls|plz|add|remove|change|update|continue|elaborate|expand|details?|shorten|simplify|refactor|optimi[sz]e|improve|redo|again|more|serious|seriously|now|instead|next|go on|keep going)\b`,
  ].join("|"),
  "iu",
);

/** A flag, a file name, a call or a name in code («--dry-run», «main.py», «run()», «snake_case»): a line about code. */
const CODE_ISH = /(?<!\S)--?\p{L}|\p{L}[._]\p{L}|\p{L}\(\)/u;

/** A laugh: «ха», «ахаха», «хехе», «лол», «ору», «)))», "haha", "hehe", "lmao". */
const LAUGH =
  /(?<!\p{L})(?:(?=[ах]*ха)[ах]{2,}|(?=[хе]*хе)[хе]{2,}|(?=[хи]*хи)[хи]{2,}|(?=[ah]*ha)[ah]{2,}|(?=[he]*he)[he]{4,}|кек\p{L}*|лол\p{L}*|ржу|ржака|ору+|орнул\p{L}*|угар\p{L}*|lol\p{L}*|lmao\p{L}*|lmfao|rofl\p{L}*|kek|xd+)(?!\p{L})|[)(]{2,}/iu;

/** A word to or about the bot, thanks, praise or a jab: «ты тормоз», «сам такой», «спасибо», «огонь», "you're a toaster". */
const BANTER_WORD = new RegExp(
  [
    String.raw`(?<![\p{L}\p{N}])(?:ты|тебя|тебе|тобой|сам|сама|сами|бот\p{L}*|пч[её]л\p{L}*)(?![\p{L}\p{N}])`,
    String.raw`(?<![\p{L}\p{N}])(?:спасиб\p{L}*|спс|пасиб\p{L}*|благодар\p{L}*|мерси|огонь|красав\p{L}*|молод(?:ец|чина|цы)|круто|класс\p{L}*|супер|кайф\p{L}*|топчик|база|имба|кринж\p{L}*|жесть|бомба|шик\p{L}*|лучш\p{L}*|гени\p{L}*|умни\p{L}*|тормоз\p{L}*|дурак\p{L}*|тупиц\p{L}*|туп(?:ой|ая|ые|ица)|глуп\p{L}*|бесишь|надоел\p{L}*|отстой|фу+|ура+|вау|офиг\p{L}*|респект|жиза|лентя\p{L}*)(?![\p{L}\p{N}])`,
    String.raw`\b(?:you|u|ur|thanks|thank|thx|ty|nice|cool|great|awesome|love|wow|omg|dumb|stupid|idiot|toaster|lame|cringe|based|goat)\b`,
  ].join("|"),
  "iu",
);

/** Shouting: a line whose letters, three or more, are all capitals. */
function shouted(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  return letters.length >= 3 && letters.every((letter) => letter !== letter.toLowerCase());
}

/** Teasing, caps and emoji are short; a longer line likely says something that deserves a real answer. */
const BANTER_MAX_WORDS = 12;

/**
 * Whether a line to the bot is banter that asks it nothing: a sign of banter, and no question, task or follow-up, no
 * link or code, a dozen words at most. «ахаха», «ну ты и тормоз», «спасибо, ты лучший», «🌸» and "lmao" are; «кто
 * прав?», «напиши скрипт», «перепиши на Go», «подробнее», «отнесись серьёзно» and "rewrite it in Go" are not, and
 * neither is a line with no sign of banter at all («на Go», «короче»): that one is answered in full.
 */
export function isBanter(text: string): boolean {
  if (!text.trim() || /https?:\/\/|`/.test(text) || CODE_ISH.test(text)) return false;
  if ((text.match(/[\p{L}\p{N}]+/gu) ?? []).length > BANTER_MAX_WORDS) return false;
  if (QUESTION.test(text) || TASK.test(text)) return false;
  return LAUGH.test(text) || /\p{Extended_Pictographic}/u.test(text) || BANTER_WORD.test(text) || shouted(text);
}

/** Emoji and what joins or varies them; a question mark among them asks something. */
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|[‍️⃣\u{e0020}-\u{e007f}]|\s)+$/u;
const ASKING_EMOJI = /[❓❔⁉]/u;

/** A message of nothing but emoji (a flower, a laugh, a heart): it gets a reaction rather than an answer. */
export function emojiOnly(text: string): boolean {
  return EMOJI_ONLY.test(text) && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(text) && !ASKING_EMOJI.test(text);
}

type Reaction = ReactionTypeEmoji["emoji"];

/**
 * The reaction to an emoji-only message, in kind: a gift or a heart gets a heart, a laugh a grin, sadness a hug, a jab an
 * unbothered moai. Telegram lets a bot react only with its own short list of emoji, so the flower itself never comes back.
 */
const REACTIONS: [string, Reaction][] = [
  ["🖕💩🤡🤮🤬😡👎😒🙄😤", "🗿"],
  ["🌸🌹🌷💐🌺🌻🌼🏵💮❤♥🧡💛💚💙💜🤍🖤🤎💖💕💗💓💞💝💘💌🫶😘😍🥰☺😊🤗🎁🍫🍬🍭🧁🍰🎂🍪🍩☕🍵🫖", "❤"],
  ["😂🤣😆😹😄😃😀😅😁😸", "😁"],
  ["😢😭😞😔😟🥺😿💔😩😫😥", "🤗"],
  ["🔥💯⚡🚀💪", "🔥"],
  ["👏🎉🥳🎊🍾🏆🥇", "🎉"],
  ["👍👌✅", "👍"],
  ["🤝🙏", "🤝"],
  ["🤔🧐🤨", "🤔"],
  ["😴💤🥱", "😴"],
];

export function reactionTo(text: string): Reaction {
  const used = new Set(Array.from(text));
  for (const [emoji, reaction] of REACTIONS) if (Array.from(emoji).some((point) => used.has(point))) return reaction;
  return "👀";
}
