/**
 * Detects the language a chat is written in, so the chronicler is told it instead of guessing.
 * Without this the model drifts towards whatever language it sees elsewhere in its input.
 * Returns an English language name, or null when the text is too short or too mixed to tell.
 */

const MIN_LETTERS = 40;
const SCRIPT_MAJORITY = 0.6;

const STOPWORDS: Record<string, string[]> = {
  English: ["the", "and", "is", "are", "to", "of", "it", "i", "you", "that", "for", "in", "on", "with", "this", "my", "but", "not", "was", "have", "just", "so", "what", "we", "be", "can", "do", "if", "me", "anyone"],
  Spanish: ["el", "los", "las", "que", "y", "es", "por", "para", "con", "una", "pero", "muy", "está", "como", "lo", "se", "del", "yo", "también", "esto"],
  German: ["der", "die", "das", "und", "ist", "nicht", "ich", "du", "mit", "auf", "für", "ein", "eine", "aber", "auch", "wir", "sie", "zu", "den", "ja"],
  French: ["le", "les", "et", "est", "pas", "je", "tu", "pour", "dans", "avec", "une", "mais", "sur", "ce", "il", "on", "des", "du", "au", "c'est"],
  Portuguese: ["os", "que", "e", "é", "não", "para", "com", "um", "uma", "mas", "eu", "você", "isso", "do", "da", "em", "no", "na", "muito", "também"],
  Italian: ["il", "che", "di", "è", "non", "per", "con", "una", "ma", "mi", "ti", "sono", "questo", "anche", "io", "gli", "del", "della", "ho", "perché"],
};
const STOPWORD_SETS = Object.fromEntries(Object.entries(STOPWORDS).map(([language, words]) => [language, new Set(words)]));

function share(text: string, pattern: RegExp, of: number): number {
  return of === 0 ? 0 : (text.match(pattern) ?? []).length / of;
}

/** Russian unless another Cyrillic language shows its own letters. */
function cyrillicLanguage(text: string, letters: number): string {
  if (share(text, /[әғқңөұүһ]/gi, letters) >= 0.01) return "Kazakh";
  if (share(text, /[ў]/gi, letters) >= 0.004) return "Belarusian";
  if (share(text, /[їєґі]/gi, letters) >= 0.01) return "Ukrainian";
  if (share(text, /[ѓќѕ]/gi, letters) >= 0.004) return "Macedonian";
  if (share(text, /[ђћџљњј]/gi, letters) >= 0.004) return "Serbian";
  if (share(text, /[ъ]/gi, letters) >= 0.01 && share(text, /[ыэ]/gi, letters) === 0) return "Bulgarian";
  return "Russian";
}

function latinLanguage(text: string): string | null {
  const words = text.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  if (words.length < 8) return null;
  const scores = Object.entries(STOPWORD_SETS)
    .map(([language, set]) => ({ language, hits: words.filter((word) => set.has(word)).length }))
    .sort((a, b) => b.hits - a.hits);
  const [best, second] = scores;
  if (!best || best.hits / words.length < 0.05) return null;
  if (second && second.hits > 0 && best.hits < second.hits * 1.3) return null;
  return best.language;
}

/** The first text set is the chat's own messages; later sets are fallbacks used only when it is too short. */
export function detectLanguage(...sources: string[][]): string | null {
  let text = "";
  for (const source of sources) {
    text += `\n${source.join("\n")}`;
    const letters = (text.match(/\p{L}/gu) ?? []).length;
    if (letters < MIN_LETTERS) continue;
    const cyrillic = (text.match(/\p{Script=Cyrillic}/gu) ?? []).length;
    const latin = (text.match(/\p{Script=Latin}/gu) ?? []).length;
    if (cyrillic / letters >= SCRIPT_MAJORITY) return cyrillicLanguage(text, cyrillic);
    if (latin / letters >= SCRIPT_MAJORITY) return latinLanguage(text);
    return null;
  }
  return null;
}
