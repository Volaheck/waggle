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
| `ADMIN_TG_IDS` | Telegram IDs of the bot owners, comma-separated (get yours from a bot like @userinfobot) |

The bot token, API key and owner IDs are written into the server's `.env` on every deploy, so rotating one is: change the secret, then Actions → `Deploy` → Run workflow on `main`. An ID removed from `ADMIN_TG_IDS` loses all owner rights, and its owner command menu, once the bot restarts.

## What a deploy does

1. Checks that the commit is still the newest on `main`. A run for an older commit — CI runs that finished out of order, a re-run of an old run — stops there instead of rolling production back. Run by hand, `Deploy` ships whatever branch or tag you pick.
2. `rsync` the repository to the server, leaving `.env`, `docker-compose.override.yml`, `backups/` and `private/` alone.
3. Writes the secrets into `.env`.
4. Builds the new image, tags the running one as `waggle-bot-bot:previous` and dumps the database to `backups/pre-deploy-<time>-<commit>.dump` (the last 10 are kept).
5. `docker compose up -d --wait` — migrations run when the bot starts. If the new release does not become healthy, the previous image is started again and the job fails; its log says whether the new release had already migrated the database. Container logs stay on the server (`docker compose logs bot`): the Actions logs of a public repository are public.

Deploys never overlap, and one that has started always finishes.

## Backups

Every day the `backup` service dumps the database to `backups/waggle-<date>.dump` and keeps 14 days of them. A dump that fails replaces and deletes nothing and is retried an hour later; `docker compose logs backup` shows `backup: FAILED` then. The files are readable only by root, since they hold the chats' data. To copy one off the server:

```bash
docker compose cp backup:/backups/waggle-2026-11-09.dump .
```

To restore a daily or a pre-deploy dump (this replaces everything in the database):

```bash
docker compose stop bot
docker compose exec -T backup pg_restore -h waggle-db -U waggle -d waggle --clean --if-exists --single-transaction /backups/waggle-2026-11-09.dump
docker compose start bot
```

A dump holds no roles. On a new server, create the role that card requests write under (migration 008) before restoring:

```bash
docker compose exec -T db psql -U waggle waggle -c 'CREATE ROLE waggle_self_edit NOLOGIN; GRANT waggle_self_edit TO waggle;'
```

To go back to the previous release by hand: `docker tag waggle-bot-bot:previous waggle-bot-bot && docker compose up -d --no-build bot`, or run `Deploy` by hand on an older tag. The next deploy from `main` replaces it again.
