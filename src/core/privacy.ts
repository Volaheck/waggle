/**
 * What the chronicler never needs and Anthropic never has to see: phone numbers, email addresses, card, account and
 * wallet numbers, other long numbers (documents, tax ids) and secrets pasted into the chat. Message texts are masked
 * right before they go into a prompt; what is stored and shown to the chat's own members stays as written.
 *
 * It errs on the side of keeping text: links, @usernames, dates, times, versions, amounts, counts and years stay,
 * because cards and the chronicle are built from them. Measured on a real chat history of ~7000 messages, it changed
 * one of them (a game friend code).
 */

/** Links stay as they are, project links matter; a link that is just a phone number or an email in disguise does not. */
const LINK = /\b(?:https?:\/\/|www\.)[^\s<>"'`)\]]+|\b(?:tel|mailto|sms|viber|whatsapp):[^\s<>"'`)\]]+/giu;
// t.me/+79123456789 opens a chat by phone number; t.me/+AbC12… with letters is a group invite and stays.
const CONTACT_LINK = /^(?:tel|sms|viber|whatsapp):|^(?:https?:\/\/)?(?:www\.)?(?:wa\.me|api\.whatsapp\.com|t\.me\/\+\d{7,15}(?:[/?#]|$))/iu;
/** The same chat-by-phone links written without a scheme. */
const CONTACT_PLAIN = /\b(?:wa\.me\/\+?|t\.me\/\+)\d{7,15}\b/giu;

/** API keys and tokens by their known shapes; a Telegram bot token also right after "bot", as in API URLs. */
const SECRET = new RegExp(
  String.raw`(?:(?:(?<=bot)|(?<![A-Za-z0-9_]))\d{8,10}:[A-Za-z0-9_-]{35}|\b(?:` +
    [
      String.raw`sk-(?:ant-)?[A-Za-z0-9_-]{20,}`,
      String.raw`(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}`,
      String.raw`gh[pousr]_[A-Za-z0-9]{30,}`,
      String.raw`github_pat_[A-Za-z0-9_]{30,}`,
      String.raw`glpat-[A-Za-z0-9_-]{20,}`,
      String.raw`xox[abprs]-[A-Za-z0-9-]{10,}`,
      String.raw`AKIA[0-9A-Z]{16}`,
      String.raw`AIza[0-9A-Za-z_-]{35}`,
      String.raw`hf_[A-Za-z0-9]{30,}`,
      String.raw`gsk_[A-Za-z0-9]{30,}`,
      String.raw`xai-[A-Za-z0-9]{30,}`,
      String.raw`eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`,
    ].join("|") +
    String.raw`))(?![A-Za-z0-9_-])`,
  "gu",
);
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu;
/** «password: Qwerty123», «API_KEY=abc123…»: the value is masked only when it looks like one (ASCII with letters and digits). */
const KEYED_SECRET = /(?<![\p{L}\p{N}_])((?:[A-Za-z0-9]+_)*(?:api[_-]?key|token|secret|password|passwd|pwd)|пароль|токен)(\s*[:=]\s*)(?!\[)([\x21-\x7E]{8,})/giu;
/** TON (EQ…/UQ…), Ethereum, Bitcoin (bc1…, 1…/3…) and TRON (T…) addresses: on-chain they show a balance and its whole history. */
const WALLET = /\b(?:(?:EQ|UQ|Ef|Uf|kQ|0Q)[A-Za-z0-9_-]{46}|0x[0-9a-fA-F]{40}|bc1[02-9ac-hj-np-z]{25,71}|[13T][1-9A-HJ-NP-Za-km-z]{25,34})(?![A-Za-z0-9_-])/gu;
/**
 * A full name with a patronymic next to a date («Иванов Пётр Сергеевич 03.04.1990»): the core of a doxxing post,
 * the kind people-lookup services print. A name with a patronymic alone, or a date alone, stays.
 */
const NAME_AND_DATE = /(?<!\p{L})((?:[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?[ \u00A0]+){2}[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?)[ \u00A0]*(?:,|г\.р\.|—|-)?[ \u00A0]*\d{1,2}\.\d{1,2}\.(?:19|20)\d{2}(?!\d)/gu;
const PATRONYMIC = /(?:ович|евич|ич|овна|евна|ична|инична)$/u;
/** «дата рождения: 03.04.1990», «д.р. 03.04.1990». */
const BIRTH_DATE = /((?:дата рождения|д\.[ \u00A0]?р\.|date of birth|DOB|born)[ \u00A0]*[:\-—]?[ \u00A0]*)\d{1,2}[./]\d{1,2}[./](?:19|20)\d{2}/giu;
const EMAIL = /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/gu;
/**
 * A run of digits, or digit groups joined by single spaces, dashes or brackets, with an optional leading +.
 * Dots, colons and commas do not join groups, so dates, times, versions and decimals are left alone. A run right
 * after a letter or a slash is part of a word or a path, and after «1.» part of a decimal; after «тел.» or «тел-» it is not.
 */
const DIGIT_RUN = /(?<![\p{L}\p{N}_@#/])(?<!\d\.)\+?(?:\(\d+\)|\d+)(?:[   -]?(?:\(\d+\)|\d+))*/gu;

/** Shorter numbers are amounts, counts, years and local extensions: nothing to protect, and the chronicle may need them. */
const LONG_NUMBER_DIGITS = 10;
/** «2023 2024 2025»: a list of years. */
const YEARS = /^(?:(?:19|20)\d{2}[   -]?)+$/u;
/** «2026-11-20 18» of «2026-11-20 18:00»: a date and an hour. */
const DATE_AND_HOUR = /^\d{4}-\d{2}-\d{2}(?:[   ]\d{1,2})?$/u;
/** «4-5-20250929» of claude-sonnet-4-5-20250929: a model's version and release date. */
const VERSION_AND_DATE = /^\d{1,2}(?:-\d{1,2})*-(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/u;
/** «1 2 3 4 5», «1 000 000 000»: a list or an amount; no document or account number is written in groups this short. */
const SMALL_SPACED_NUMBERS = /^\d{1,3}(?:[   ]\d{1,3})+$/u;

function passesLuhn(digits: string): boolean {
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

function maskDigits(run: string): string {
  const digits = run.replace(/\D/g, "");
  if (digits.length < LONG_NUMBER_DIGITS || YEARS.test(run) || DATE_AND_HOUR.test(run) || VERSION_AND_DATE.test(run)) return run;
  if (run.startsWith("+") || run.includes("(")) return digits.length <= 15 ? "[phone]" : "[number]";
  if ((digits.length === 11 && /^[78]/.test(digits)) || (digits.length === 10 && digits.startsWith("9"))) return "[phone]";
  if (SMALL_SPACED_NUMBERS.test(run)) return run;
  if (digits.length >= 13 && digits.length <= 19 && passesLuhn(digits)) return "[card]";
  return "[number]";
}

/** Base58 addresses mix upper case, lower case and digits; a long lowercase word that starts with 1, 3 or T is not one. */
function maskWallet(match: string): string {
  const rest = match.slice(1);
  if (/^[13T]/.test(match) && !(/[A-HJ-NP-Z]/.test(rest) && /[a-km-z]/.test(rest) && /\d/.test(rest))) return match;
  if (match.startsWith("T") && match.length !== 34) return match;
  return "[account]";
}

function maskKeyedSecret(whole: string, key: string, separator: string, value: string): string {
  // Punctuation after the value belongs to the sentence.
  const secret = value.replace(/[.,;:!?)\]}]+$/u, "");
  const looksLikeOne = secret.length >= 8 && /[A-Za-z]/.test(secret) && /\d/.test(secret);
  return looksLikeOne ? `${key}${separator}[secret]${value.slice(secret.length)}` : whole;
}

function maskNameAndDate(whole: string, name: string): string {
  return name.split(/[ \u00A0]+/u).some((word) => PATRONYMIC.test(word)) ? "[person]" : whole;
}

function maskPlainText(text: string): string {
  return text
    .replace(PRIVATE_KEY, "[secret]")
    .replace(NAME_AND_DATE, maskNameAndDate)
    .replace(BIRTH_DATE, "$1[birthdate]")
    .replace(CONTACT_PLAIN, "[phone]")
    .replace(SECRET, "[secret]")
    .replace(KEYED_SECRET, maskKeyedSecret)
    .replace(WALLET, maskWallet)
    .replace(EMAIL, "[email]")
    .replace(IBAN, (match) => (match.replace(/ /g, "").length >= 15 ? "[account]" : match))
    .replace(DIGIT_RUN, maskDigits);
}

export function maskPersonalData(text: string): string {
  let result = "";
  let from = 0;
  for (const match of text.matchAll(LINK)) {
    const at = match.index;
    result += maskPlainText(text.slice(from, at));
    // Punctuation right after a link belongs to the sentence.
    const link = match[0].replace(/[.,!?;:]+$/u, "");
    // A kept link still loses a token in its path or query and a login in its address (user:password@host).
    result += CONTACT_LINK.test(link) ? "[phone]" : /^mailto:/i.test(link) ? "[email]" : link.replace(SECRET, "[secret]").replace(EMAIL, "[email]");
    from = at + link.length;
  }
  return result + maskPlainText(text.slice(from));
}

/** The placeholders masking puts into a text; a new expression each time, as a global one keeps its place between uses. */
const placeholders = () => /\[(?:phone|email|card|account|number|secret|person|birthdate)\]/g;

/** What each placeholder in a text's masked form stands for, in order; none when the two cannot be lined up. */
function maskedValues(original: string): { masked: string; values: { placeholder: string; value: string }[] } {
  const masked = maskPersonalData(original);
  const found = [...masked.matchAll(placeholders())];
  const kept = masked.split(placeholders());
  const values: { placeholder: string; value: string }[] = [];
  if (!original.startsWith(kept[0]!)) return { masked, values: [] };
  let at = kept[0]!.length;
  for (const [index, placeholder] of found.entries()) {
    const next = kept[index + 1]!;
    // Two placeholders side by side leave no telling where one value ends.
    const end = next === "" ? (index === found.length - 1 ? original.length : -1) : original.indexOf(next, at + 1);
    if (end <= at) return { masked, values: [] };
    values.push({ placeholder: placeholder[0], value: original.slice(at, end) });
    at = end + next.length;
  }
  return { masked, values };
}

/**
 * A text written from masked words (a reminder the reading worded) with its placeholders back as they were written:
 * found within one of the originals' masked forms, it takes the values at that place; otherwise a placeholder takes the
 * only value of its kind the originals hold. One that cannot be told stays a placeholder. What is stored and shown to
 * the chat's own members stays as written; only what goes to Anthropic is masked.
 */
export function unmaskFrom(text: string, originals: string[]): string {
  if (!placeholders().test(text)) return text;
  const lined = originals.map(maskedValues);
  for (const { masked, values } of lined) {
    const at = masked.toLowerCase().indexOf(text.toLowerCase());
    if (at < 0 || values.length === 0) continue;
    let index = [...masked.slice(0, at).matchAll(placeholders())].length;
    return text.replace(placeholders(), (placeholder) => (values[index]?.placeholder === placeholder ? values[index++]!.value : placeholder));
  }
  const onlyValue = (placeholder: string) => {
    const found = new Set(lined.flatMap(({ values }) => values.filter((value) => value.placeholder === placeholder).map((value) => value.value)));
    return found.size === 1 ? [...found][0]! : placeholder;
  };
  return text.replace(placeholders(), onlyValue);
}
