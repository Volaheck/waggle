import { timingSafeEqual } from "node:crypto";
import { BotError, type Bot, type Context } from "grammy";
import type { Update } from "grammy/types";

/**
 * Telegram delivers an update again when the answer is not 2xx or comes late, and the second delivery would
 * repeat whatever the first one already did. So Telegram always gets 200, at the latest after this long;
 * a slower handler keeps running after the answer.
 */
const ANSWER_WITHIN_MS = 8_000;

export interface TelegramWebhook {
  /** Answers Telegram's POST: 401 without the secret token, otherwise 200. */
  handle: (request: Request) => Promise<Response>;
  /** Resolves once every update received so far has been handled. */
  settle: () => Promise<void>;
}

export function telegramWebhook<C extends Context>(bot: Bot<C>, secretToken: string, answerWithinMs = ANSWER_WITHIN_MS): TelegramWebhook {
  const expected = Buffer.from(secretToken);
  const inFlight = new Set<Promise<void>>();

  const fromTelegram = (request: Request): boolean => {
    const given = Buffer.from(request.headers.get("x-telegram-bot-api-secret-token") ?? "");
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  // grammY passes middleware errors to the bot.catch handler only in long polling; with a webhook it is done here.
  const handleUpdate = async (update: Update): Promise<void> => {
    try {
      await bot.handleUpdate(update);
    } catch (error) {
      if (!(error instanceof BotError)) throw error;
      await bot.errorHandler(error as BotError<C>);
    }
  };

  const track = (update: Update): Promise<void> => {
    const task: Promise<void> = handleUpdate(update)
      .catch((error: unknown) => console.error(`[bot] update ${update.update_id} failed:`, error))
      .finally(() => inFlight.delete(task));
    inFlight.add(task);
    return task;
  };

  return {
    async handle(request) {
      if (!fromTelegram(request)) return new Response(null, { status: 401 });
      let update: Update;
      try {
        update = (await request.json()) as Update;
      } catch {
        return new Response(null, { status: 400 });
      }
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([track(update), new Promise<void>((resolve) => (timer = setTimeout(resolve, answerWithinMs)))]);
      clearTimeout(timer);
      return new Response(null, { status: 200 });
    },
    async settle() {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
  };
}
