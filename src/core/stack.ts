/**
 * Tools of one vendor are one fact on a card: «GPT-6», «ChatGPT», «Codex» and «GPT Astra»
 * all say the same thing — the person uses OpenAI. Each family has one label.
 */
const FAMILIES: { key: string; label: string; pattern: RegExp }[] = [
  { key: "openai", label: "GPT / Codex", pattern: /\b(gpt[\w.-]*|chat\s?gpt|codex|openai|o[1-9](-\w+)?|sora|astra)\b/i },
  { key: "anthropic", label: "Claude", pattern: /\b(claude|anthropic|opus|sonnet|haiku)\b/i },
  { key: "google", label: "Gemini", pattern: /\b(gemini|bard|ai\s?studio|notebooklm)\b/i },
  { key: "moonshot", label: "Kimi", pattern: /\bkimi\b/i },
  { key: "zhipu", label: "GLM", pattern: /\b(glm[\w.-]*|z\.ai|zhipu)\b/i },
  { key: "xai", label: "Grok", pattern: /\bgrok\b/i },
  { key: "deepseek", label: "DeepSeek", pattern: /\bdeepseek\b/i },
  { key: "qwen", label: "Qwen", pattern: /\bqwen\b/i },
  { key: "mistral", label: "Mistral", pattern: /\b(mistral|codestral)\b/i },
  { key: "meta-llama", label: "Llama", pattern: /\bllama\b/i },
  { key: "cursor", label: "Cursor", pattern: /\bcursor\b/i },
  { key: "opencode", label: "OpenCode", pattern: /\bopen\s?code\b/i },
];

export interface StackFamily {
  key: string;
  label: string;
}

/**
 * The family of the tool the fact is about — judged by the head of the value, so
 * «Claude Code (вместе с Codex)» is Claude, not OpenAI. The earliest mention wins.
 */
export function stackFamily(value: string): StackFamily | null {
  const head = value.split(/\s[—–-]\s|[(:]/)[0] ?? value;
  let best: { index: number; family: (typeof FAMILIES)[number] } | null = null;
  for (const family of FAMILIES) {
    const match = family.pattern.exec(head);
    if (match && (!best || match.index < best.index)) best = { index: match.index, family };
  }
  return best ? { key: best.family.key, label: best.family.label } : null;
}

/** «Gemini, ChatGPT» → ["Gemini", "ChatGPT"]: one tool per fact. */
export function splitStackValue(value: string): string[] {
  const parts = value
    .split(/\s*(?:,|;|\/|\+|\s&\s|\sи\s)\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length <= 1) return [value.trim()];
  // «GPT / Codex» is a family label, not two tools.
  const families = new Set(parts.map((part) => stackFamily(part)?.key ?? part.toLowerCase()));
  return families.size === 1 ? [value.trim()] : parts;
}

/** What a stack fact should be stored as: the family label when the tool belongs to a known family. */
export function canonicalStackValue(value: string): string {
  return stackFamily(value)?.label ?? value.trim();
}
