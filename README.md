# 🐝 Waggle

**A Telegram bot that remembers your group chat for you.**

Honeybees do a *waggle dance* to tell the hive where the good flowers are. Waggle does the same for a group chat: it keeps a chronicle of what mattered, a card for every member and a catalog of everyone's projects with a rating — so newcomers get up to speed in minutes and nobody has to scroll back through thousands of messages.

> The bot speaks Russian to its users (it was built for a Russian-speaking community). Code, docs and logs are in English.

## What it does

- **Chronicle — "the main stuff".** Not a transcript but a digest: the chronicler picks the events that mattered and rates each from 1 to 5. The chronicle tab shows the top 5 for a day, 10 for a week, 15 for a month. `/catchup` sends you what you missed.
- **Member cards.** Role, stack, expertise, interests — collected from the conversation as it happens, with a link to the message each fact came from. People edit, hide or remove anything about themselves.
- **Project catalog with a rating.** Projects are detected from the chat; the rating comes from real signals the chronicler notices — feedback, actual usage, contributions, releases — plus 👍 votes, with anti-gaming rules.
- **No duplicates, by meaning.** «GPT-6», «ChatGPT» and «Codex» are one fact; a topic about *Nova Glass* goggles is not linked to a member's project called *nova*. Deterministic rules catch the obvious cases, a weekly LLM clean-up catches the rest.
- **Any number of chats.** Add the bot to another group and, once an owner approves it, that chat gets its own chronicle, cards and catalog. A person in two chats has two independent cards; nothing leaks between chats.
- **Full-featured text bot + Mini App.** Everything works through commands and inline buttons; the Mini App (React) mirrors it with a calm UI that follows the Telegram light/dark theme.

## How it spends tokens

Bot commands never call the LLM — they read the database. The model runs on a schedule: every `EXTRACTION_INTERVAL_HOURS` (6 by default) it takes everything that piled up since the previous pass and processes it in one call to `claude-haiku-5-5`. If nothing new was written, there is no call. A weekly clean-up pass runs only if cards changed. Spending is capped per month for the whole bot (`MONTHLY_LLM_BUDGET_USD`) and for each chat (`CHAT_MONTHLY_BUDGET_USD`); owners get a message when a cap is hit. For a chat with ~100 messages a day this is well under a dollar a month.

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
| `/links` | links shared in the chat |
| `/whatyouknow`, `/forgetme` | privacy |
| `/chats` | owner: approve or reject chats, attach imported history |
| `/botstatus`, `/link Name` | owner: status per chat; link a seeded card to an account (reply to their message) |

In DM the bot works with one chat at a time; if you are in several, it asks which one and remembers the choice (🔁 switches).

## Running it

1. Create a bot with [@BotFather](https://t.me/BotFather), disable privacy mode (`/setprivacy` → Disable) and add it to your group as an admin without moderation rights.
2. `cp .env.example .env` and fill it in. Put your Telegram ID into `ADMIN_TG_IDS` (message the bot to learn it).
3. `docker compose up -d --build`
4. Add the bot to a group. If an owner added it, the chat is approved at once; otherwise owners get an approve/reject request in DM. Until then the bot reads and stores nothing from that chat.
5. Optional: load starting cards and a project catalog — `docker compose exec -e SEED_CHAT_ID=-100… bot node dist/scripts/seed.js seed/people.json seed/projects.json`. Without `SEED_CHAT_ID` they wait as imported history, and `/chats` offers to attach them to a chat. See `seed/example-*.json` for the format. Real community data stays out of git (`seed/*.json` is ignored).
6. Cards link to Telegram accounts automatically by @username or name when people write. Anyone left over can be linked with `/link Name` as a reply to their message; `/botstatus` lists unlinked cards.

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

Waggle never records politics, health, finances, private life, addresses or secrets — the prompts forbid it and a stop-list filters it. Every fact links to its source message, people can hide or remove facts (a removed fact never comes back, even reworded), and `/forgetme` deletes everything about a person.
