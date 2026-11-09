import { z } from "zod";

const csvIds = z
  .string()
  .default("")
  .transform((raw) =>
    raw
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map(Number),
  );

const EnvSchema = z.object({
  BOT_TOKEN: z.string().min(10),
  /** Bot owners: they approve new chats and get alerts. */
  ADMIN_TG_IDS: csvIds,
  DATABASE_URL: z.string().url(),
  ANTHROPIC_API_KEY: z.string().optional(),
  BOT_MODE: z.enum(["polling", "webhook"]).default("polling"),
  PUBLIC_URL: z.string().url().optional(),
  WEBHOOK_SECRET: z.string().min(16).optional(),
  BOT_APP_SHORT_NAME: z.string().optional(),
  PORT: z.coerce.number().int().default(8787),
  EXTRACTION_MODEL: z.string().default("claude-sonnet-5-5"),
  EXTRACTION_INTERVAL_HOURS: z.coerce.number().positive().default(6),
  /** Message texts older than this are cleared once the chronicler has processed them; the rows stay. */
  MESSAGE_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
  DISPLAY_TIMEZONE: z.string().default("UTC"),
  /** Cap for the whole bot, across all chats. */
  MONTHLY_LLM_BUDGET_USD: z.coerce.number().default(60),
  /** Default cap per chat; an owner can set another one for a chat. */
  CHAT_MONTHLY_BUDGET_USD: z.coerce.number().default(20),
  WEB_DIST_DIR: z.string().default("web/dist"),
  /** Local development only: open the Mini App in a plain browser via a secret link printed at startup. */
  DEV_BROWSER_LOGIN: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  /** @username or name to act as; empty = the first admin, else the first member. */
  DEV_LOGIN_AS: z.string().default(""),
});

export type Config = z.infer<typeof EnvSchema>;

let cached: Config | undefined;

/** `KEY=` with nothing after it, as .env.example ships the optional keys, means the key is not set. */
function withoutBlankValues(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1].trim() !== ""));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(withoutBlankValues(env));
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid environment variables:\n${problems.join("\n")}`);
  }
  if (parsed.data.DEV_BROWSER_LOGIN && env.NODE_ENV === "production") {
    throw new Error("DEV_BROWSER_LOGIN must not be enabled in production");
  }
  if (parsed.data.BOT_MODE === "webhook" && (!parsed.data.PUBLIC_URL || !parsed.data.WEBHOOK_SECRET)) {
    throw new Error("BOT_MODE=webhook requires PUBLIC_URL and WEBHOOK_SECRET");
  }
  cached = parsed.data;
  return cached;
}

export function resetConfigForTests(): void {
  cached = undefined;
}
