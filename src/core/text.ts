export function normalizeValue(value: string): string {
  return value
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[«»"'`.,!?;:()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Word stems matched from the start of a word, so «налог» does not fire on «аналог».
 * Words a tech chat uses in another sense stay out of both lists: health check, flutter doctor, tech debt, cost savings.
 * How a project makes money is project news, so «доход», «заработок» and «income» are allowed;
 * personal money (salaries, debts, savings) and any amount of money are not (see MONEY_AMOUNT).
 */
const FORBIDDEN_STEMS = [
  "политик", "путин", "зеленск", "трамп", "войн", "всу", "мобилиз", "оппозиц", "санкци",
  "здоров", "болезн", "болеет", "диагноз", "лечени", "таблетк", "депресс", "терапи", "врач",
  "зарплат", "ипотек", "налог", "сбережен", "задолж",
  "девушк", "развод", "отношени", "свидани", "секс",
  "адрес", "улиц", "квартир", "прописк",
  "религи", "национальн", "ориентац",
  "politic", "putin", "zelensk", "mobiliz", "mobilis", "sanction",
  "illness", "disease", "diagnosis", "diagnosed", "medicat", "depression", "depressed", "therap", "hospital", "pregnan", "mental health",
  "salar", "mortgage",
  "girlfriend", "boyfriend", "divorc", "sexual",
  "home address", "apartment",
  "religio", "nationalit", "ethnic",
];

/** Short words that are forbidden only as whole words («долг», but not «долгие»; «tax», but not «taxi»). */
const FORBIDDEN_WORDS = [
  "долг", "долги", "долгов", "жена", "жены", "жене", "муж", "мужа", "мужем",
  "war", "wars", "trump", "tax", "taxes", "loan", "loans", "wife", "wives", "husband", "husbands", "sex",
];

const FORBIDDEN_PATTERN = new RegExp(
  `(?<![\\p{L}])(?:${FORBIDDEN_STEMS.join("|")})|(?<![\\p{L}])(?:${FORBIDDEN_WORDS.join("|")})(?![\\p{L}])`,
  "u",
);

/** An amount of money: «$500», «500 долларов», «50к рублей», «€20», «3 млн ₽». */
const MONEY_AMOUNT =
  /[$€£₽]\s?\d|\d[\d\s.,]*\s?(?:k|к|тыс\.?|млн|млрд)?\s?(?:[$€£₽]|руб(?:л|\.|(?!\p{L}))|р\.|долл|бакс|евро(?!\p{L})|usd(?!\p{L})|eur(?:os?)?(?!\p{L})|rub(?!\p{L})|dollars?|bucks)/iu;

export function hasForbiddenTopic(value: string): boolean {
  return FORBIDDEN_PATTERN.test(normalizeValue(value)) || MONEY_AMOUNT.test(value);
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;

export function extractUrls(text: string): string[] {
  const matches = text.match(URL_PATTERN) ?? [];
  return [...new Set(matches.map((url) => url.replace(/[.,!?;:]+$/, "")))];
}

export function normalizeUrl(raw: string): { norm: string; domain: string } | null {
  try {
    const url = new URL(raw);
    const domain = url.hostname.replace(/^www\./, "").toLowerCase();
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith("utm_") || key === "ref" || key === "si") url.searchParams.delete(key);
    }
    const pathname = url.pathname.replace(/\/+$/, "");
    const search = url.searchParams.toString();
    return { norm: `${domain}${pathname}${search ? `?${search}` : ""}`.toLowerCase(), domain };
  } catch {
    return null;
  }
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function messageLink(chatId: number, msgId: number): string {
  const internalId = String(chatId).replace(/^-100/, "").replace(/^-/, "");
  return `https://t.me/c/${internalId}/${msgId}`;
}

export function slugify(name: string): string {
  const translit: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k",
    л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts",
    ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  };
  const latin = [...name.toLowerCase()].map((char) => translit[char] ?? char).join("");
  return latin.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "project";
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}
