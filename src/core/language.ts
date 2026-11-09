/**
 * Detects the language a chat is written in, so the chronicler is told it instead of guessing.
 * Without this the model drifts towards whatever language it sees elsewhere in its input.
 * Returns an English language name, or null when the text is too short or too mixed to tell.
 *
 * Every message votes on its own, weighted by its letters up to a cap: one long pasted text
 * counts like a few ordinary messages, and one member writing in another language does not
 * relabel the whole chat. A language is named only when it holds a clear majority.
 */

const MIN_LETTERS = 40;
const MIN_TEXT_LETTERS = 3;
const LETTER_CAP = 120;
const MAJORITY = 0.6;
const WORDS_PER_TEXT = 40;

const STOPWORDS: Record<string, string[]> = {
  English: ["the", "and", "is", "are", "to", "of", "it", "i", "you", "that", "for", "in", "on", "with", "this", "my", "but", "not", "was", "have", "just", "so", "what", "we", "be", "can", "do", "if", "me", "anyone"],
  Spanish: ["el", "los", "las", "que", "y", "es", "por", "para", "con", "una", "pero", "muy", "está", "como", "lo", "se", "del", "yo", "también", "esto"],
  German: ["der", "die", "das", "und", "ist", "nicht", "ich", "du", "mit", "auf", "für", "ein", "eine", "aber", "auch", "wir", "sie", "zu", "den", "ja"],
  French: ["le", "les", "et", "est", "pas", "je", "tu", "pour", "dans", "avec", "une", "mais", "sur", "ce", "il", "on", "des", "du", "au", "c'est"],
  Portuguese: ["os", "que", "e", "é", "não", "para", "com", "um", "uma", "mas", "eu", "você", "isso", "do", "da", "em", "no", "na", "muito", "também"],
  Italian: ["il", "che", "di", "è", "non", "per", "con", "una", "ma", "mi", "ti", "sono", "questo", "anche", "io", "gli", "del", "della", "ho", "perché"],
};
const STOPWORD_SETS = Object.fromEntries(Object.entries(STOPWORDS).map(([language, words]) => [language, new Set(words)]));

/** Links, @usernames and code are Latin whatever language the chat speaks. */
const NOT_LANGUAGE = /```[\s\S]*?```|`[^`\n]*`|\bhttps?:\/\/\S+|\bwww\.\S+|@[A-Za-z0-9_]{3,}/g;

function count(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

/** Russian unless the text shows letters of another Cyrillic language. */
function cyrillicLanguage(text: string, letters: number): string {
  const share = (pattern: RegExp) => count(text, pattern) / letters;
  if (share(/[әғқңөұүһ]/gi) >= 0.01) return "Kazakh";
  if (share(/[ў]/gi) >= 0.004) return "Belarusian";
  if (share(/[їєґі]/gi) >= 0.01) return "Ukrainian";
  if (share(/[ѓќѕ]/gi) >= 0.004) return "Macedonian";
  if (share(/[ђћџљњј]/gi) >= 0.004) return "Serbian";
  if (share(/[ъ]/gi) >= 0.01 && share(/[ыэ]/gi) === 0) return "Bulgarian";
  return "Russian";
}

function latinLanguage(words: string[]): string | null {
  if (words.length < 8) return null;
  const scores = Object.entries(STOPWORD_SETS)
    .map(([language, set]) => ({ language, hits: words.filter((word) => set.has(word)).length }))
    .sort((a, b) => b.hits - a.hits);
  const [best, second] = scores;
  if (!best || best.hits / words.length < 0.05) return null;
  if (second && second.hits > 0 && best.hits < second.hits * 1.3) return null;
  return best.language;
}

interface Vote {
  script: "cyrillic" | "latin" | "other";
  weight: number;
  /** The Cyrillic language of this text; Latin languages are told apart by the words of all Latin texts. */
  cyrillic?: string;
  words?: string[];
}

function voteOf(raw: string): Vote | null {
  const text = raw.replace(NOT_LANGUAGE, " ");
  const letters = count(text, /\p{L}/gu);
  if (letters < MIN_TEXT_LETTERS) return null;
  const weight = Math.min(letters, LETTER_CAP);
  const cyrillic = count(text, /\p{Script=Cyrillic}/gu);
  if (cyrillic / letters >= MAJORITY) return { script: "cyrillic", weight, cyrillic: cyrillicLanguage(text, cyrillic) };
  if (count(text, /\p{Script=Latin}/gu) / letters >= MAJORITY) {
    return { script: "latin", weight, words: (text.toLowerCase().match(/[\p{L}']+/gu) ?? []).slice(0, WORDS_PER_TEXT) };
  }
  return { script: "other", weight };
}

function decide(votes: Vote[]): string | null {
  const total = votes.reduce((sum, vote) => sum + vote.weight, 0);
  const ofScript = (script: Vote["script"]) => votes.filter((vote) => vote.script === script);
  const cyrillic = ofScript("cyrillic");
  const cyrillicWeight = cyrillic.reduce((sum, vote) => sum + vote.weight, 0);
  if (cyrillicWeight / total >= MAJORITY) {
    const byLanguage = new Map<string, number>();
    for (const vote of cyrillic) byLanguage.set(vote.cyrillic!, (byLanguage.get(vote.cyrillic!) ?? 0) + vote.weight);
    const [language, weight] = [...byLanguage].sort((a, b) => b[1] - a[1])[0]!;
    return weight / cyrillicWeight >= MAJORITY ? language : null;
  }
  const latin = ofScript("latin");
  if (latin.reduce((sum, vote) => sum + vote.weight, 0) / total >= MAJORITY) return latinLanguage(latin.flatMap((vote) => vote.words ?? []));
  return null;
}

/** The first text set is the chat's own messages; later sets are fallbacks used only while there is too little text. */
export function detectLanguage(...sources: string[][]): string | null {
  const votes: Vote[] = [];
  for (const source of sources) {
    for (const text of source) {
      const vote = voteOf(text);
      if (vote) votes.push(vote);
    }
    if (votes.reduce((sum, vote) => sum + vote.weight, 0) >= MIN_LETTERS) return decide(votes);
  }
  return null;
}
