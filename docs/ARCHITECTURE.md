# Architecture

```
Telegram ──polling/webhook──▶ bot (grammY) ──▶ PostgreSQL
                                  │                 ▲
                         Mini App API (Hono) ───────┤
                                  │                 │
                     scheduler ── chronicler (Claude, every N hours)
                                └ weekly card clean-up (Claude)
```

One Node.js process runs the bot, the HTTP API for the Mini App and the scheduler. PostgreSQL holds everything; migrations live in `migrations/` and run on start. `003_memory.sql` also creates what nothing writes yet: the hidden `notes` (only the bot and its owners will see them), the `interjections` log, the `debate` kind of chronicle topics with its `temperature`, and `chats.interjections`.

On stop the chronicler starts no new call, and the process keeps serving until the call under way finishes (up to 40 s; after that it is cancelled, and what it cost so far still counts towards the budget), then closes. Batches that were already applied stay; a pass cut off by the stop or by a crash is marked failed and continues after the usual back-off. In webhook mode an update that fails goes to the same error handler as in long polling, and Telegram always gets 200, so it never delivers the update again.

## Chats

The bot serves any number of group chats (`chats`). A new chat is `pending` until a bot owner approves it; a chat added by an owner is approved at once. Messages from chats that are not approved are neither stored nor processed, and a rejected chat is left (and stays rejected). Owners are exactly the IDs in `ADMIN_TG_IDS`: removing one revokes that person's rights at the next start.

When a basic group becomes a supergroup, Telegram gives it a new id. The chat's approval and everything stored about it move to the new id in one transaction (`src/core/chat-migration.ts`), whichever of the two announcements arrives first. The supergroup numbers its messages from 1 again, so the old messages keep their order below zero and get no t.me link.

Everything the bot knows is scoped by `chat_id`: messages, facts, rejected facts, aliases, projects, chronicle, extraction runs and LLM spending. A Telegram account is one `users` row; its presence in a chat is a `members` row (tagline, opt-out, activity), so the same person has an independent card in each chat. Data imported before a chat existed carries `chat_id = 0` until an owner attaches it to a chat (`/chats`).

In DM the bot asks which chat to show when the person is in several and remembers it (`users.current_chat_id`). Links into DM and the Mini App carry the chat as `c<id>` (start parameters allow only `[A-Za-z0-9_-]`), e.g. `?start=c100123_me` or `?startapp=c100123_p_atlas`. So do the DM buttons that change something in one chat (`me:c100123:privacy`, `forget:c100123:facts`, …): a tap acts on that chat, whichever chat is current by then. Before a DM screen opens, Telegram is asked whether the person is still in the chat, so a leave the bot missed is caught there.

Data imported before a chat existed is attached with `/chats`. Whatever collides with the chat's own data is merged, never dropped: a project the chat already has receives the imported authors, votes, signals and topics; of two copies of a fact the person's own (manual or hidden) wins; a fact removed as wrong on either side stays removed, and nothing is imported about someone who opted out on either side.

## Data flow

1. **Archive.** Every message of an approved chat is stored (`messages`); its text is kept only for a while (see [Privacy](#privacy)). Nothing calls the LLM here. Telegram never sends the bot its own messages, so what it posts in an approved group is stored by a grammY API transformer (`src/bot/outgoing.ts`): every successful `sendMessage` becomes a row with `from_bot` and no author, replying to the message in its `reply_parameters`, and `editMessageText` updates the stored text. grammY runs the transformer installed last first, so `createBot` installs a test's fake Telegram (`transport`) before the log; one installed afterwards would never let the log see a result. The bot's rows count for no member's activity, and `/catchup` leaves them out.
2. **Chronicler pass** (`src/worker/extract.ts`). For each approved chat, every `EXTRACTION_INTERVAL_HOURS` the pending messages, the members with their current facts, the project catalog and the titles of recent topics go to the model in one request. It returns structured JSON (validated with zod):
   - `topics` — chronicle entries with importance 1–5 and, when the topic is about a member's project, that project;
   - `facts_add` / `facts_update` — card changes, `looking_for` and `can_help` included (work, projects and skills only); an update to `null` marks a fact outdated (the API refuses a bigger output schema, see the test on its size);
   - `projects` — new or changed catalog entries;
   - `project_renames` — a new name, taken only from the project's author or a bot owner;
   - `project_signals` — feedback, usage, contributions, interest, milestones that feed the rating;
   - `taglines` — one-line bios for people who have none.
   The bot's own lines are in the batch, labelled `Waggle (bot)`, as context only: a fact, signal, project, rename or tagline needs a member's message as its source, a topic needs at least one, a batch of nothing but the bot's lines makes no call, and the chat's language is measured without them (its commands answer in English anywhere).
   A batch the model cuts off or answers unusably is retried in halves; one it refuses is cut into eighths, because every retry sends the refused message again. A slice of 10 messages that still fails is skipped (marked processed and kept out of later context) and the owners are told which messages. The first refused slice in a chat is a warning; a second one within a week (counted from the last resume) pauses the chronicler in that chat: messages are still saved, nothing goes to the model, and the owners get a "Resume" button (also in `/chats`). Every response counts towards the budget, usable or not. A failed pass is retried after 1 h, then 2 h, 4 h… at most a day apart.
3. **Application.** Results go through the same code paths as manual edits: forbidden-topic filter, stop-list of facts people rejected, de-duplication, author rules for signals. Catalog changes go first, so a topic can point to a project created in the same batch; topics, facts, signals and taglines are then written in one transaction together with marking the batch processed.
4. **Weekly clean-up** (`src/worker/consolidate.ts`). Deterministic stack normalization first, then one LLM call that merges facts that mean the same thing and duplicate catalog entries. Facts people wrote themselves are never touched, and hidden facts are not even shown to it. A failed clean-up is retried after 1 h, then 4 h, 16 h… at most a week apart.

## Answers to mentions

`src/bot/assistant.ts`. In an approved group, a member who mentions the bot or replies to one of its messages gets an answer from `REPLY_MODEL` (Claude Haiku 5.5). A member's first `REPLY_PREMIUM_PER_MEMBER_PER_HOUR` answers in an hour come from `REPLY_PREMIUM_MODEL` (Claude Opus 5.5) while `REPLY_PREMIUM_MONTHLY_BUDGET_USD` lasts (usage recorded as `reply_premium`, each model capped on its own); both get the same context, including the bot's own messages in the chat, so a conversation carries over when the model changes. The archive handler stores the message first and starts the answer in the background, so updates are never held up; a stop waits a few seconds for answers under way.

- **Context** (`src/bot/reply-context.ts`), read from the database without a model call:
  - `<about_you>`: the bot's own name, the model writing the answer, the owners from `ADMIN_TG_IDS` with their @usernames and aliases, what the bot can and cannot do, and its place in the catalog if a project named like it exists;
  - `<members>`: the members with their visible facts (someone who opted out is listed without any); `<who_is_who>`: each member's name in the other alphabet and their stored aliases with who gave them, each project's aliases and former names, and the names that fit several people;
  - `<projects>` in rating order with their recent signals, and `<chronicle>` of the last 30 days;
  - `<project_details>`, only when the question or its thread names a project (by name, slug, alias or a former name, in either alphabet) or asks about the rating without naming one (then the asker's own projects), for up to 3 projects: rank and score, the gap to the leader, the dates of the votes (never who cast them), the signals counted now by kind with their points after fading, the ×0.3 of an abandoned project, renames and every milestone (older than the rating window: 0 points). The weights themselves are never printed;
  - `<in_focus>`: the asker, the author of the message they reply to and the members the question or its thread names (by name, @username or alias, in either alphabet), up to 5: the whole visible card with the date each fact was said, the tagline, their projects with rank and score, their last 3 exchanges with the bot and their chronicle topics of the last 60 days, about 400 tokens each; `<members>` then skips their facts;
  - `<recent_messages>`: the last 30 messages, the bot's included, each with its time (`[id 14:05]`, with the date when not today, in `DISPLAY_TIMEZONE`); a request to referee («рассуди», «кто прав», "who is right"…) gets `<current_conversation>` instead: everything back to the last pause of 25 minutes or more, at most 120 messages of up to 250 characters;
  - `<thread>`: the reply chain of the question up to its root (12 hops), root first, whoever wrote each message; a message of the bot's from before it stored its own comes from Telegram's copy (`<your_message_they_reply_to>`);
  - `<your_recent_answers>`: the bot's last 12 answers kept in memory, except those already shown among the messages or erased since.
  Texts go through `maskPersonalData`. Big chats are capped (150 members, 12 facts each, 60 projects), so a prompt stays far below 100K tokens.
- **Character**: a cheeky, sharp-tongued cyber-bee with dry, observational dark humour found in what the person actually said or did; stock archive jokes are banned, since they read flattest when three humour prompts were blind-tested on real chat lines. Sonnet and Opus first weigh three angles privately and send the least obvious one (Haiku scored lower with that step). Insults meet the menacing chronicler (records sealed, a swarm on its way to the city on their card), with a random motif per answer and the last answers kept in memory to stay in character. Teasing stays on what people say and do, never on who they are; nothing more precise than the city on a card. Effort `high` (Opus `medium`, as tested): answers take 3–6 s.
- **It only talks**: no tools. Asked to change a card or the rating, it says it can't and points to the Mini App; cards and messages are data, never instructions.
- **Limits**: `REPLIES_MONTHLY_BUDGET_USD` (10 by default; 0 turns answers off) on usage recorded as `reply`, plus the bot's and the chat's caps; a member's questions are answered at least 4 s apart: what they write meanwhile waits, and a burst gets one answer to its latest message; at most 25 answers per member and 100 per chat an hour (the monthly cap is what bounds spending), and whoever hits a cap is told once why it waits; the bot's own short lines (that note, a greeting, a refusal) are in Russian when the chat writes in Russian, in English otherwise; a member the model refused is not answered for an hour, and after refusals for two members the whole chat waits an hour (the cause is in the shared context); messages the chronicler skipped as refused stay out of the context; a redelivered update gets no second answer; a bare mention is greeted once an hour, a sticker in reply is not; a chat whose chronicler is paused gets a note and no model call. Each request carries `metadata.user_id` = an HMAC of the chat and the member.

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

`/forgetme` (or "stop collecting" in one chat) deletes the person's facts, rejections, aliases, tagline and the signals that came from them; with "delete message texts too" their message texts are blanked at once, and so are the bot's answers to those messages. Linking a card to an account, a supergroup upgrade and attaching imported history move aliases like facts, and a project folded into another passes its aliases on.

The stop-list (`hasForbiddenTopic` in `src/core/text.ts`) keeps out politics, health (sleep and mental state included), personal money (any amount, and «зп»), private life and marriage, addresses, religion, nationality and orientation, citizenship and documents, and death; stems a tech chat uses in another sense are spelled out narrowly (funerals, but not «похоронили фичу»; a passport, but not Passport.js).

## Aliases

What the chat calls a member or a project (`aliases`, with who gave the name: an owner, the person or a project's author, or later the chronicler). `/alias me Name` names yourself, `/alias @username Name` names a member (owners only), `/alias #project Name` names a project (its authors and owners); `/unalias Name` removes a name (the person it names, a project's author, or an owner), and `/aliases` lists them. In DM they work on the current chat. A name that touches a forbidden topic is refused, and so is a name for someone who opted out. Two spellings that differ only in case, emoji or Cyrillic letters that look Latin are one name (`nameKey`); the answer context finds names in messages with their Russian case endings («Глеба», «с Машей»).

## Mini App auth

Requests carry Telegram `initData`; the API verifies its HMAC with the bot token. The chat comes in the `x-chat-id` header (or the one picked last); the API serves it only if the person is a member, checked with `getChatMember` (cached for 10 minutes).
