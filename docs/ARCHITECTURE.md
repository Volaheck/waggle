# Architecture

```
Telegram ──polling/webhook──▶ bot (grammY) ──▶ PostgreSQL
                                  │                 ▲
                         Mini App API (Hono) ───────┤
                                  │                 │
                     scheduler ── chronicler (Claude, every N hours)
                                └ weekly card clean-up (Claude)
```

One Node.js process runs the bot, the HTTP API for the Mini App and the scheduler. PostgreSQL holds everything; migrations live in `migrations/` and run on start.

## Chats

The bot serves any number of group chats (`chats`). A new chat is `pending` until a bot owner (`ADMIN_TG_IDS`) approves it; a chat added by an owner is approved at once. Messages from chats that are not approved are neither stored nor processed, and a rejected chat is left.

Everything the bot knows is scoped by `chat_id`: messages, facts, rejected facts, projects, chronicle, links, extraction runs and LLM spending. A Telegram account is one `users` row; its presence in a chat is a `members` row (tagline, opt-out, activity), so the same person has an independent card in each chat. Data imported before a chat existed carries `chat_id = 0` until an owner attaches it to a chat (`/chats`).

In DM the bot asks which chat to show when the person is in several and remembers it (`users.current_chat_id`). Links into DM and the Mini App carry the chat as `c<id>` (start parameters allow only `[A-Za-z0-9_-]`), e.g. `?start=c100123_me` or `?startapp=c100123_p_atlas`.

## Data flow

1. **Archive.** Every message of an approved chat is stored as is (`messages`). Links are collected into `links`. Nothing calls the LLM here.
2. **Chronicler pass** (`src/worker/extract.ts`). For each approved chat, every `EXTRACTION_INTERVAL_HOURS` the pending messages, the members with their current facts, the project catalog and the titles of recent topics go to the model in one request. It returns structured JSON (validated with zod):
   - `topics` — chronicle entries with importance 1–5 and, when the topic is about a member's project, that project;
   - `facts_add` / `facts_update` / `facts_outdated` — card changes;
   - `projects` — new or changed catalog entries;
   - `project_signals` — feedback, usage, contributions, interest, milestones that feed the rating;
   - `taglines` — one-line bios for people who have none.
3. **Application.** Results go through the same code paths as manual edits: forbidden-topic filter, stop-list of facts people rejected, de-duplication, author rules for signals.
4. **Weekly clean-up** (`src/worker/consolidate.ts`). Deterministic stack normalization first, then one LLM call that merges facts that mean the same thing and duplicate catalog entries. Facts people wrote themselves are never touched.

## De-duplication

- `src/core/stack.ts` folds tools of one vendor into one family label («GPT / Codex», «Claude», «Gemini», …) and splits combined values («A, B»).
- `isSameFact` compares stack facts by family and other facts by their core («Codex (Max plan)» ≈ «Codex»), with a word-overlap rule for multi-word values.
- Projects match by slug, name, shared link, or a near-identical name with a common author.
- Topics and messages are linked to projects only by the model's judgement of meaning, never by a word match.

## Rating

`score = 5 × votes + Σ impact × kind weight × e^(−age / 45 days)` over the last 180 days of signals; abandoned projects get ×0.3. One signal of each kind per person per project per week; authors can only report milestones of their own project. Users only see that the chronicler decides.

## Mini App auth

Requests carry Telegram `initData`; the API verifies its HMAC with the bot token. The chat comes in the `x-chat-id` header (or the one picked last); the API serves it only if the person is a member, checked with `getChatMember` (cached for 10 minutes).
