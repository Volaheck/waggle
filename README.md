# 🐝 Waggle

**A Telegram bot that remembers your group chat for you.**

Honeybees do a *waggle dance* to tell the hive where the good flowers are. Waggle does the same for a group chat: it keeps a chronicle of what mattered, a card for every member and a catalog of everyone's projects with a rating — so newcomers get up to speed in minutes and nobody has to scroll back through thousands of messages.

> The bot's interface is in English; what it collects from a chat — the chronicle, member facts and taglines — is written in that chat's own language. Code, docs and logs are in English.

## What it does

- **Chronicle — "the main stuff".** Not a transcript but a digest: the chronicler picks the events that mattered and rates each from 1 to 5. The chronicle tab shows the top 5 for a day, 10 for a week, 15 for a month. `/catchup` sends you what you missed.
- **Member cards.** Role, stack, expertise, interests — collected from the conversation as it happens, with a link to the message each fact came from. People edit, hide or remove anything about themselves.
- **Project catalog with a rating.** Projects are detected from the chat; the rating comes from real signals the chronicler notices — feedback, actual usage, contributions, releases — plus 👍 votes, with anti-gaming rules.
- **No duplicates, by meaning.** «GPT-6», «ChatGPT» and «Codex» are one fact; a topic about *Nova Glass* goggles is not linked to a member's project called *nova*. Deterministic rules catch the obvious cases, a weekly LLM clean-up catches the rest.
- **Any number of chats.** Add the bot to another group and, once an owner approves it, that chat gets its own chronicle, cards and catalog. A person in two chats has two independent cards; nothing leaks between chats.
- **Ask the bot.** Mention @waggle_robot or reply to its message and it answers from what it knows: who knows what, which projects lead the rating, what the chat discussed. It answers with Claude Haiku, only talks (it never changes cards or the rating) and has its own monthly cap.
- **Full-featured text bot + Mini App.** Everything works through commands and inline buttons; the Mini App (React) mirrors it with a calm UI that follows the Telegram light/dark theme.

## How it spends tokens

Bot commands never call the LLM — they read the database. Only a mention of the bot, or a reply to it, gets an answer from `claude-haiku-5-5` (`REPLY_MODEL`): about $0.002 an answer, capped at `REPLIES_MONTHLY_BUDGET_USD` (10 by default) a month across all chats. With `REPLY_PREMIUM_MONTHLY_BUDGET_USD` above 0, a member's first `REPLY_PREMIUM_PER_MEMBER_PER_HOUR` answers in an hour (10 by default) come from `REPLY_PREMIUM_MODEL` (`claude-opus-5-5`, about $0.06 an answer) until that cap is used up for the month; both models get the same context, so a conversation carries over. A member's questions are answered at least 4 s apart (a burst gets one answer, nothing is dropped), at most 50 answers per member and 250 per chat an hour. The chronicler runs on a schedule: every `EXTRACTION_INTERVAL_HOURS` (6 by default) it takes everything that piled up since the previous pass and processes it in one call to `claude-sonnet-5-5` (configurable with `EXTRACTION_MODEL`). If nothing new was written, there is no call. A weekly clean-up pass runs only if cards changed. Spending is capped per month for the whole bot (`MONTHLY_LLM_BUDGET_USD`) and for each chat (`CHAT_MONTHLY_BUDGET_USD`); owners get a message when a cap is hit. For a busy chat with 100–250 messages a day this comes to roughly $4–7 a month on Sonnet 5.5; `claude-haiku-5-5` costs about 20 times less per token.

## Commands

| Command | What it does |
|---|---|
| `/me` | your card: tagline, add facts, hide or remove facts, privacy, your projects |
| `/who @user` (or as a reply) | someone's card |
| `/people` | all members |
| `/whoknows topic` | who has experience with a topic |
| `/top`, `/projects` | project rating: top, active, new |
| `/project name` | project card, 👍 vote, editing for authors |
| `/addproject url description` | add your project |
| `/catchup [hours]` | what you missed (sent privately) |
| `/chronicle`, `/today`, `/week` | the chronicle |
| `/whatyouknow`, `/forgetme` | privacy |
| `/chats` | owner: approve or reject chats, attach imported history |
| `/botstatus`, `/link @username Name` | owner: status per chat (asked in a group, it comes to the owner's DM); link an imported card to an account (or `/link Name` as a reply to their message) |

In DM the bot works with one chat at a time; if you are in several, it asks which one and remembers the choice (🔁 switches).

## Running it

1. Create a bot with [@BotFather](https://t.me/BotFather), disable privacy mode (`/setprivacy` → Disable) and add it to your group as an admin without moderation rights.
2. `cp .env.example .env` and fill it in. Put your Telegram ID into `ADMIN_TG_IDS` (get it from a bot like @userinfobot).
3. `docker compose up -d --build --wait` — it fails if the bot does not start; `docker compose logs bot` says why.
4. Add the bot to a group. If an owner added it, the chat is approved at once; otherwise owners get an approve/reject request in DM. Until then the bot reads and stores nothing from that chat.
5. Optional: load starting cards and a project catalog (see `seed/example-*.json` for the format). Put `people.json` and `projects.json` into `private/seed/` (`private/` stays out of git, the Docker image and deploys) and run:

   ```bash
   docker compose run --rm --user "$(id -u)" -v "$PWD/private/seed:/app/import:ro" -e SEED_CHAT_ID=-100… \
     bot node dist/scripts/seed.js import/people.json import/projects.json
   ```

   `--user` lets the container read files that only you can read. Without `SEED_CHAT_ID` the cards wait as imported history, and `/chats` offers to attach them to a chat.
6. Cards link to Telegram accounts automatically when people write: by @username, or by name when the match is unambiguous and harmless — the only unlinked card with that name in the chat, with no @username of its own, no other chat and no projects. An export names people as the exporter's contacts do, so some are missed. When the bot sees an account in a chat for the first time while the chat still has unlinked cards active in the last 60 days (a card without messages counts from its import), the owners get a DM with those cards as buttons, the likeliest by name first, and link one with a tap or answer "None of them"; a card with its own @username is left for that account. Up to 10 such questions per chat a day, then one note instead. `/link @username Name` (or `/link Name` as a reply) links one by hand: the exact name first, then one that differs only in case, emoji or Cyrillic letters that look Latin; namesakes come back as buttons. `/botstatus` lists unlinked cards, and so does the message after attaching an import. Linking moves the card's messages, facts, projects, votes and chronicle topics to the account; an opt-out on either side wins.

**Mini App:** create it with `/newapp` in BotFather pointing to `https://<your-domain>/app/`, then set `PUBLIC_URL` and `BOT_APP_SHORT_NAME`.

Deploying to your own server with GitHub Actions is described in [docs/DEPLOY.md](docs/DEPLOY.md).

## Development

```bash
npm install && npm --prefix web install
npm run typecheck
TEST_DATABASE_URL=postgres://… npm test   # without it only unit tests run
npm run dev
```

With `DEV_BROWSER_LOGIN=true` the dev server prints a secret link that opens the Mini App in a normal browser (never enabled in production).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit together.

## Privacy

Waggle never records politics, health, finances, private life, addresses or secrets — the prompts forbid it and a stop-list filters it. Only text goes to Claude, never photos or files, and phone numbers, emails, card and account numbers and pasted secrets are masked before it does. If Claude keeps refusing a chat's messages, the chronicler pauses there until a bot owner resumes it. Every fact links to its source message, people can hide or remove facts (a removed fact never comes back, even reworded), and `/forgetme` deletes everything about a person.

Message texts are kept for 7 days (`MESSAGE_RETENTION_DAYS`): after that, as soon as the chronicler has processed a message, its text is deleted. What stays of the message is its author and time, so links to source messages and activity counts keep working. A message the chronicler has not processed yet — say, while a spending cap pauses it — keeps its text until it has been processed.
