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

On stop the chronicler starts no new call, and the process keeps serving until the call under way finishes (up to 40 s; after that it is cancelled, and what it cost so far still counts towards the budget), then closes. Batches that were already applied stay; a pass cut off by the stop or by a crash is marked failed and continues after the usual back-off. In webhook mode an update that fails goes to the same error handler as in long polling, and Telegram always gets 200, so it never delivers the update again.

## Chats

The bot serves any number of group chats (`chats`). A new chat is `pending` until a bot owner approves it; a chat added by an owner is approved at once. Messages from chats that are not approved are neither stored nor processed, and a rejected chat is left (and stays rejected). Owners are exactly the IDs in `ADMIN_TG_IDS`: removing one revokes that person's rights at the next start.

When a basic group becomes a supergroup, Telegram gives it a new id. The chat's approval and everything stored about it move to the new id in one transaction (`src/core/chat-migration.ts`), whichever of the two announcements arrives first. The supergroup numbers its messages from 1 again, so the old messages keep their order below zero and get no t.me link.

Everything the bot knows is scoped by `chat_id`: messages, facts, rejected facts, projects, chronicle, extraction runs and LLM spending. A Telegram account is one `users` row; its presence in a chat is a `members` row (tagline, opt-out, activity), so the same person has an independent card in each chat. Data imported before a chat existed carries `chat_id = 0` until an owner attaches it to a chat (`/chats`).

In DM the bot asks which chat to show when the person is in several and remembers it (`users.current_chat_id`). Links into DM and the Mini App carry the chat as `c<id>` (start parameters allow only `[A-Za-z0-9_-]`), e.g. `?start=c100123_me` or `?startapp=c100123_p_atlas`. So do the DM buttons that change something in one chat (`me:c100123:privacy`, `forget:c100123:facts`, …): a tap acts on that chat, whichever chat is current by then. Before a DM screen opens, Telegram is asked whether the person is still in the chat, so a leave the bot missed is caught there.

Data imported before a chat existed is attached with `/chats`. Whatever collides with the chat's own data is merged, never dropped: a project the chat already has receives the imported authors, votes, signals and topics; of two copies of a fact the person's own (manual or hidden) wins; a fact removed as wrong on either side stays removed, and nothing is imported about someone who opted out on either side.

## Data flow

1. **Archive.** Every message of an approved chat is stored (`messages`); its text is kept only for a while (see [Privacy](#privacy)). Nothing calls the LLM here.
2. **Chronicler pass** (`src/worker/extract.ts`). For each approved chat, every `EXTRACTION_INTERVAL_HOURS` the pending messages, the members with their current facts, the project catalog and the titles of recent topics go to the model in one request. It returns structured JSON (validated with zod):
   - `topics` — chronicle entries with importance 1–5 and, when the topic is about a member's project, that project;
   - `facts_add` / `facts_update` — card changes; an update to `null` marks a fact outdated (the API refuses a bigger output schema, see the test on its size);
   - `projects` — new or changed catalog entries;
   - `project_renames` — a new name, taken only from the project's author or a bot owner;
   - `project_signals` — feedback, usage, contributions, interest, milestones that feed the rating;
   - `taglines` — one-line bios for people who have none.
   A batch the model cuts off or answers unusably is retried in halves; one it refuses is cut into eighths, because every retry sends the refused message again. A slice of 10 messages that still fails is skipped (marked processed and kept out of later context) and the owners are told which messages. The first refused slice in a chat is a warning; a second one within a week (counted from the last resume) pauses the chronicler in that chat: messages are still saved, nothing goes to the model, and the owners get a "Resume" button (also in `/chats`). Every response counts towards the budget, usable or not. A failed pass is retried after 1 h, then 2 h, 4 h… at most a day apart.
3. **Application.** Results go through the same code paths as manual edits: forbidden-topic filter, stop-list of facts people rejected, de-duplication, author rules for signals. Catalog changes go first, so a topic can point to a project created in the same batch; topics, facts, signals and taglines are then written in one transaction together with marking the batch processed.
4. **Weekly clean-up** (`src/worker/consolidate.ts`). Deterministic stack normalization first, then one LLM call that merges facts that mean the same thing and duplicate catalog entries. Facts people wrote themselves are never touched, and hidden facts are not even shown to it. A failed clean-up is retried after 1 h, then 4 h, 16 h… at most a week apart.

## Answers to mentions

`src/bot/assistant.ts`. In an approved group, a member who mentions the bot or replies to one of its messages gets an answer from `REPLY_MODEL` (Claude Haiku 5.5). The archive handler stores the message first and starts the answer in the background, so updates are never held up; a stop waits a few seconds for answers under way.

- **Context**: the members with their visible facts (someone who opted out is listed without any), the projects in rating order with their recent signals, the chronicle of the last 30 days, the last 30 messages and, for a reply, the bot's own message. Texts go through `maskPersonalData`. Big chats are capped (150 members, 12 facts each, 60 projects), so a prompt stays far below 100K tokens.
- **Character**: a cheeky, sharp-tongued cyber-bee; insults meet the menacing chronicler (records sealed, the archive never forgets, a swarm on its way to the city on their card), with a random motif per answer and the last answers kept in memory to stay in character. Teasing stays on what people say and do, never on who they are; nothing more precise than the city on a card. Effort `high`: answers take 3–6 s.
- **It only talks**: no tools. Asked to change a card or the rating, it says it can't and points to the Mini App; cards and messages are data, never instructions.
- **Limits**: `REPLIES_MONTHLY_BUDGET_USD` (10 by default; 0 turns answers off) on usage recorded as `reply`, plus the bot's and the chat's caps; a member's questions are answered at least 4 s apart: what they write meanwhile waits, and a burst gets one answer to its latest message; at most 20 answers per chat an hour, and a busy chat is told once why it waits; a member the model refused is not answered for an hour; a chat whose chronicler is paused gets a note and no model call. Each request carries `metadata.user_id` = an HMAC of the chat and the member.

## De-duplication

- `src/core/stack.ts` folds tools of one vendor into one family label («GPT / Codex», «Claude», «Gemini», …) and splits combined values («A, B»).
- `isSameFact` compares stack facts by family and other facts by their core («Codex (Max plan)» ≈ «Codex»), with a word-overlap rule for multi-word values.
- The chronicler's projects match by slug, name, shared link, or a near-identical name with a common author. A member adding a project by hand never merges into someone else's: the bot says the project is already in the catalog.
- Topics and messages are linked to projects only by the model's judgement of meaning, never by a word match.

## Rating

`score = 5 × votes + Σ impact × kind weight × e^(−age / 45 days)` over the last 180 days of signals; abandoned projects get ×0.3. One signal of each kind per person per project per week; authors can only report milestones of their own project. Users only see that the chronicler decides.

## Privacy

What reaches Anthropic is only text: photos, videos and files are never sent, a media message shows as `[photo]` and the like. Before a message goes into a prompt, `maskPersonalData` (`src/core/privacy.ts`) replaces phone numbers, emails, card numbers (Luhn-checked), IBANs, other numbers of 10+ digits and pasted keys or tokens with `[phone]`, `[email]`, `[card]`, `[account]`, `[number]` and `[secret]`; links stay, except contact links like `tel:` or `wa.me`. The stored text is not changed. Every request names the chat to Anthropic only as `metadata.user_id`, an HMAC of the chat id keyed with the bot token, so abuse can be told apart per chat without revealing which chat it is.

Message texts are kept for `MESSAGE_RETENTION_DAYS` (7 by default). At start and then every hour, whether the chronicler is on or not, a job (`startMessageRetention` in `src/worker/scheduler.ts`) clears the text and the forward source of every message that is older than that and already processed (`extracted_at` is set). A message the chronicler has not processed yet — while a spending cap pauses it, for example — keeps its text until it has been processed. The row itself stays (ids, author, time), so links to source messages and activity counts keep working. Whatever shows message text skips blank ones: the project's "In the chat" messages in the Mini App, the chronicler's `<context>` (a media message without a caption still shows as `[photo]` and the like) and the mentions in `/catchup`.

`/forgetme` (or "stop collecting" in one chat) deletes the person's facts, rejections, tagline and the signals that came from them; with "delete message texts too" their message texts are blanked at once.

## Mini App auth

Requests carry Telegram `initData`; the API verifies its HMAC with the bot token. The chat comes in the `x-chat-id` header (or the one picked last); the API serves it only if the person is a member, checked with `getChatMember` (cached for 10 minutes).
