# 🐝 Waggle

**A Telegram bot that remembers your group chat for you.**

Honeybees do a *waggle dance* to tell the hive where the good flowers are. Waggle does the same for a group chat: it keeps a chronicle of what mattered, a card for every member and a catalog of everyone's projects with a rating — so newcomers get up to speed in minutes and nobody has to scroll back through thousands of messages.

> The bot's interface is in English; what it collects from a chat — the chronicle, member facts and taglines — is written in that chat's own language. Code, docs and logs are in English.

## What it does

- **Chronicle — "the main stuff".** Not a transcript but a digest: the chronicler picks the events that mattered and rates each from 1 to 5. The chronicle tab shows the top 5 for a day, 10 for a week, 15 for a month. `/catchup` sends you what you missed.
- **Member cards.** Role, stack, expertise, interests, what someone is looking for in their work and what they can help with — collected from the conversation as it happens, with a link to the message each fact came from. The names the chat calls someone are on the card too, so anyone can see and correct them. People edit, hide or remove anything about themselves.
- **Project catalog with a rating.** Projects are detected from the chat; the rating comes from real signals the chronicler notices — feedback, actual usage, contributions, releases — plus 👍 votes, with anti-gaming rules.
- **No duplicates, by meaning.** «GPT-6», «ChatGPT» and «Codex» are one fact; a topic about *Nova Glass* goggles is not linked to a member's project called *nova*. Deterministic rules catch the obvious cases, a weekly LLM clean-up catches the rest.
- **Any number of chats.** Add the bot to another group and, once an owner approves it, that chat gets its own chronicle, cards and catalog. A person in two chats has two independent cards; nothing leaks between chats.
- **A memory the members don't see.** Besides the public cards, the chronicler keeps private notes that only the bot and its owners see: corrections, what people claim or promise about their tools and projects (and whether they kept it), forecasts with the date to check them, stances, the chat's running jokes with their latest twist, the bot's own bouts with members and what members say about it. The bot answers people with their own history; owners look through the notes and delete them with `/notes`, and `/forgetme` erases them with everything else. The same people coming back to the same argument is found in the chronicle, whatever alphabet they name their tools in.
- **Ask the bot.** Mention @waggle_robot or reply to its message and it answers from what it knows: who knows what, which projects lead the rating and why, what the chat discussed. It follows a conversation back to where it started (its own messages included), knows when each message was written, who the people named in a question are — by name, @username, nickname or the other alphabet — and who built it; asked about the conversation under way — to settle it, sum it up or write it down — it reads all of it. It answers people with their own dated words: a promise past its due date, a stance they now contradict, their last attempt to outwit it. It answers with Claude Haiku, only talks (an answer never changes cards or the rating) and has its own monthly cap.
- **It speaks up, rarely.** Once a day the chronicle's topics are grouped into the themes the chat keeps coming back to: the arguments it keeps having and its long-running subjects, each with the words that bring it up. When the same people are back on one of them, or a running joke resurfaces by its name, the bot may chip in uninvited with one line from that history — at most 3 times a chat a day, 3 hours apart, the same theme at most once a day. Owners turn it off for a chat in `/chats`.
- **Full-featured text bot + Mini App.** Everything works through commands and inline buttons; the Mini App (React) mirrors it with a calm UI that follows the Telegram light/dark theme.

## How it spends tokens

A member can also ask the bot in the chat to change their own card («запиши мне стек: Rust», «убери из карточки PHP»); it reads only the sender's own words, changes only the sender's own card (enforced by the database, whatever anyone writes) and posts a receipt with Undo (about $0.0003 a request). Bot commands never call the LLM — they read the database. Only a mention of the bot, or a reply to it, gets an answer from `claude-haiku-5-5` (`REPLY_MODEL`): about $0.002 an answer, capped at `REPLIES_MONTHLY_BUDGET_USD` (10 by default) a month across all chats. With `REPLY_PREMIUM_MONTHLY_BUDGET_USD` above 0, a member's first `REPLY_PREMIUM_PER_MEMBER_PER_HOUR` answers in an hour (10 by default) come from `REPLY_PREMIUM_MODEL` (`claude-opus-5-5`, about $0.07 an answer without the prompt cache) until that cap is used up for the month; it is counted in no other cap, so the stronger model never silences a chat or stops its chronicler, and the most a month can cost is `MONTHLY_LLM_BUDGET_USD` plus this cap. Both models get the same context, so a conversation carries over, and its unchanging part is served from the prompt cache, which makes an answer in a running conversation two to three times cheaper. A member's questions are answered at least 4 s apart (a burst gets one answer, nothing is dropped), at most 25 answers per member and 100 per chat an hour; these hourly limits, and the stronger model's hourly share, are counted from the answers the bot posted, so a restart does not reset them. Speaking up uninvited costs one call to the answering model (the stronger one while its cap lasts) when a live conversation matches a theme the chat keeps coming back to (at most one call per theme an hour, in the answers' caps; `INTERJECTIONS_PER_CHAT_PER_DAY` and `INTERJECTION_MIN_GAP_HOURS` bound how often it talks, 0 turns it off). The chronicler runs on a schedule: every `EXTRACTION_INTERVAL_HOURS` (6 by default), and in a busy chat as soon as `EXTRACTION_PASS_MESSAGES` members' messages wait (200 by default, no sooner than `EXTRACTION_MIN_GAP_MINUTES`, 60, after the previous pass), it takes everything that piled up since the previous pass and processes it in one call to `claude-sonnet-5-5` (configurable with `EXTRACTION_MODEL`) for the chronicle and the cards, followed by a second call on the same messages for the private notes (recorded as `extract_notes`, within the same caps), which adds roughly half as much again. If nothing new was written, there is no call. A weekly clean-up pass runs only if cards changed. Once a day, when the chronicle has new topics, one more call to the same model groups them into the chat's recurring themes (recorded as `themes`, about $0.05 for a chat with a few hundred topics). Once a week, on an active week's afternoon, the bot suggests one improvement to itself for the chat, from what members asked it, what it could not do and what they wished it could: a short post in the chat, and the full case with "take it / decline / done" buttons for the owners, who decide (one call to `REPLY_PREMIUM_MODEL`, recorded as `ideas`, about $0.15; off for a chat in /chats). The bot never changes itself: its developer builds what the owners take. Everything but the stronger model's answers is capped per month for the whole bot (`MONTHLY_LLM_BUDGET_USD`) and for each chat (`CHAT_MONTHLY_BUDGET_USD`); owners get a message when a cap is hit. For a busy chat with 100–250 messages a day this comes to roughly $4–7 a month on Sonnet 5.5; `claude-haiku-5-5` costs about 20 times less per token. Notes work the same way: a member writes their own, about themselves or about a project of theirs, by asking the bot («добавь заметку: …») or in the Mini App; they show on the card and the project's page, and the bot reads them as the person's own word. Where people are works like the rest of the card: the chronicler picks it up from what they say («я в Торонто»; «у меня 16:20» tells which zone of their «Индонезия» it is, checked in code), the Mini App takes the device's zone on the first visit, and a member corrects their own («поставь мне пояс Торонто», or in the Mini App). The bot reads «завтра» in the asker's own time.

## Commands

| Command | What it does |
|---|---|
| `/me` | your card: tagline, add facts, hide or remove facts, privacy, your projects |
| `/who @user` (or as a reply) | someone's card |
| `/people` | all members |
| `/whoknows topic` | who has experience with a topic |
| `/alias me Name`, `/aliases`, `/unalias Name` | what the chat calls you; all such names; remove one (yours, or any for an owner) |
| `/alias @username Name`, `/alias #project Name` | owner: what the chat calls a member; owner or the project's author: another name of a project |
| `/top`, `/projects` | project rating: top, active, new |
| `/project name` | project card, 👍 vote, editing for authors |
| `/addproject url description` | add your project |
| `/catchup [hours]` | what you missed (sent privately) |
| `/chronicle`, `/today`, `/week` | the chronicle |
| `/whatyouknow`, `/forgetme` | privacy |
| `/chats` | owner: approve or reject chats, attach imported history, let the bot speak up uninvited in a chat or not |
| `/botstatus`, `/link @username Name` | owner: status per chat, today's interjections included (asked in a group, it comes to the owner's DM); link an imported card to an account (or `/link Name` as a reply to their message) |
| `/notes [@user]` | owner: the chat's private notes, newest first, with a delete button each (asked in a group, they come to the owner's DM) |

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
6. Cards link to Telegram accounts automatically when people write, by @username only: a name proves nothing, since anyone can copy one. An export names people as the exporter's contacts do, so some are missed. When the bot sees an account in a chat for the first time while the chat still has unlinked cards active in the last 60 days (a card without messages counts from its import), the owners get a DM with those cards as buttons, the likeliest by name first, and link one with a tap or answer "None of them"; a card with its own @username is left for that account. Up to 10 such questions per chat a day, then one note instead. `/link @username Name` (or `/link Name` as a reply) links one by hand: the exact name first, then one that differs only in case, emoji or Cyrillic letters that look Latin; namesakes come back as buttons. `/botstatus` lists unlinked cards, and so does the message after attaching an import. Linking moves the card's messages, facts, projects, votes and chronicle topics to the account; an opt-out on either side wins.

7. After upgrading from a version without private notes, the chronicler's notes call can go once through the messages of the last week it processed before, storing only notes and aliases (about one notes call a day of a busy chat, recorded as `backfill`):

   ```bash
   docker compose exec bot node dist/scripts/backfill-notes.js --dry-run   # prints what it would store
   docker compose exec bot node dist/scripts/backfill-notes.js
   ```

   A chat it went through is left alone the next time (`--again` repeats it); `--chat <id>` and `--days <n>` narrow it down. It prints anyone who objected to being recorded, for the owners to follow up.

**Mini App:** create it with `/newapp` in BotFather pointing to `https://<your-domain>/app/`, then set `PUBLIC_URL` and `BOT_APP_SHORT_NAME`.

**Deleted and edited messages in your own DMs (owners, Telegram Premium):** turn on Secretary Mode for the bot in BotFather (/mybots → the bot → Bot Settings → Secretary Mode; it used to be called Business Mode), then in Telegram open Settings → Telegram Business → Chat Automation, pick the bot and the chats it may read; it needs no right to reply. From then on the bot keeps the other side's messages in those chats for `BUSINESS_MESSAGE_RETENTION_DAYS` (30 by default) and, in your DM with it, shows what a message said once it is deleted (photos, videos, voice and files are sent back) or what it said before an edit. Your own messages are never kept; disconnecting deletes everything it kept. Only accounts in `ADMIN_TG_IDS` get this: for anyone else who connects the bot, it keeps nothing unless they start a portrait (below). Telegram does not say who deleted a message, and the bot sees only messages that arrived after it was connected.

**Reminders of promises and plans** come from the same connection: the bot reads those chats, both sides, once a conversation has been quiet for 10 minutes (or after an hour of a lively one) with `BUSINESS_REMINDER_MODEL` (`claude-haiku-5-5`, a fraction of a cent a read), and notes firm commitments — "I'll send you the contract tomorrow", the other person's "will call you tonight", "let's meet on Thursday at 7". It says quietly what it noted (✖ drops it), then reminds you in your DM with it: of a plan two hours ahead, of your own promise an hour ahead or that morning, of theirs when it is due; ✅ Done, ⏰ In 1 h and 📅 Tomorrow answer a reminder, and `/reminders` lists what is open. When the chat shows a promise kept or a plan cancelled or moved, it closes or moves the reminder itself. The lines are kept for 2 days, and their text goes to Claude with phone numbers, emails and secrets masked. Its own cap is `BUSINESS_REMINDERS_MONTHLY_BUDGET_USD` (2 by default, 0 turns reminders off), within `MONTHLY_LLM_BUDGET_USD`. Times are in `DISPLAY_TIMEZONE`.

**A private portrait of your character (anyone):** `/portrait` in a DM with the bot, then 🪞 Start. From then on the bot reads what you write in the groups it is in and, if you connected it to your account as above, both sides of your private chats, and puts together an honest portrait of who you are: how you think, feel and treat people, what drives you, how you see yourself and where you act otherwise, your shadow side and your strengths, and signs of neurodivergence (autism, ADHD) or of your mental state, with what speaks against them. Signs, never diagnoses. `PORTRAIT_READER_MODEL` (`claude-sonnet-5-5`) reads your messages into observations, each resting on your own lines, about once a day; `PORTRAIT_MODEL` (`claude-opus-5-5`) writes the portrait from them once there are enough and again every few days, and sends it to you. Only you see it: not the groups, not the Mini App, not the owners' commands. Message texts are deleted once read (masked for Claude like everything else); the observations with short quotes of your words and the portrait stay until you delete them (🗑 in `/portrait`, or `/forgetme`). Any account can start one, not only owners: `PORTRAIT_MONTHLY_BUDGET_USD` (20 by default, 0 turns portraits off) caps them all, within `MONTHLY_LLM_BUDGET_USD`, and `PORTRAIT_PERSON_MONTHLY_USD` (3) caps each person but the owners.

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

Waggle never records politics, health (sleep and mental state included), finances and wealth, private life and marriage, orientation, nationality, citizenship and documents, death, addresses, logins, passwords or other secrets — the prompts forbid it and a stop-list filters it, in the public cards and the private notes alike. Only text goes to Claude, never photos or files, and phone numbers, emails, card and account numbers and pasted secrets are masked before it does. If Claude keeps refusing a chat's messages, the chronicler pauses there until a bot owner resumes it. Every fact links to its source message, people can hide or remove facts (a removed fact never comes back, even reworded), and `/forgetme` deletes everything about a person, the names the chat calls them by and the private notes about them included. Someone who tells the chat they don't want to be recorded is noted for the owners, who get a DM about it once; the bot never jokes about it.

Message texts are kept for 7 days (`MESSAGE_RETENTION_DAYS`): after that, as soon as the chronicler has processed a message, its text is deleted. The bot's own messages in a group are kept the same way, so it can follow a conversation with it (and so is the copy of each line it said uninvited); deleting your message texts with `/forgetme` deletes the bot's answers to them as well. What stays of the message is its author and time, so links to source messages and activity counts keep working. A message the chronicler has not processed yet — say, while a spending cap pauses it — keeps its text until it has been processed.
