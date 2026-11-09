# Deploying with GitHub Actions

`CI` runs type checks, tests (against PostgreSQL) and both builds on every push and pull request. When it passes on `main`, `Deploy` ships the code to your server over SSH and restarts it with Docker Compose. In a fork without deploy secrets the deploy job is skipped.

## Server, once

1. A Linux host with Docker and the Compose plugin, and a user that can run `docker`.
2. Create the app directory (`~/waggle` by default, or set the `DEPLOY_DIR` repository variable) with a `.env` that holds what is not managed by GitHub:

   ```bash
   POSTGRES_PASSWORD=<long random string>
   BOT_MODE=polling
   PUBLIC_URL=https://waggle.example.com
   BOT_APP_SHORT_NAME=app
   DISPLAY_TIMEZONE=Europe/Berlin
   ```

   Anything from `.env.example` can go here. The database password never leaves the server.
3. Authorize a dedicated deploy key: add its public half to `~/.ssh/authorized_keys` of that user.
4. Optional: if a reverse proxy on the same host should reach the bot through a Docker network (for the Mini App and webhooks), describe it in a server-only `docker-compose.override.yml` — Compose merges it automatically and deploys never touch it:

   ```yaml
   services:
     bot:
       networks:
         default: {}
         edge:
           aliases: [waggle-bot]
   networks:
     edge:
       external: true
       name: my-proxy_default
   ```

   The proxy then forwards your domain to `waggle-bot:8787`.

## GitHub secrets

Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | server address |
| `DEPLOY_USER` | SSH user |
| `DEPLOY_SSH_KEY` | private half of the deploy key |
| `BOT_TOKEN` | token from @BotFather |
| `ANTHROPIC_API_KEY` | Claude API key |
| `ADMIN_TG_IDS` | Telegram IDs of the bot owners, comma-separated (message the bot to learn yours) |

The bot token, API key and owner IDs are written into the server's `.env` on every deploy, so rotating one is: change the secret, re-run `Deploy`.

## What a deploy does

1. `rsync` the repository to the server, leaving `.env`, `docker-compose.override.yml`, `backups/` and `private/` alone.
2. Write the secrets into `.env`.
3. `docker compose up -d --build --wait` — migrations run when the bot starts; the deploy fails if the container does not become healthy.

Daily database dumps land in `backups/` on the server (kept for 14 days).
