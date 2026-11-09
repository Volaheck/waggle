-- The bot's memory of conversations: its own messages, the names people go by, what only the bot keeps about
-- people and the chat, debates in the chronicle and the bot speaking up on its own.

-- Telegram never sends the bot its own messages, so the bot stores what it posts in a group itself (user_id is NULL).
ALTER TABLE messages ADD COLUMN from_bot boolean NOT NULL DEFAULT false;

-- What a member or a project is called in the chat: set by a bot owner, by the person themselves, or noticed by the chronicler.
CREATE TABLE aliases (
  id         serial PRIMARY KEY,
  chat_id    bigint NOT NULL,
  user_id    integer REFERENCES users(id) ON DELETE CASCADE,
  project_id integer REFERENCES projects(id) ON DELETE CASCADE,
  alias      text NOT NULL,
  alias_norm text NOT NULL,
  source     text NOT NULL CHECK (source IN ('owner', 'person', 'chronicler')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(user_id, project_id) = 1)
);
CREATE UNIQUE INDEX aliases_unique ON aliases (chat_id, alias_norm, coalesce(user_id, 0), coalesce(project_id, 0));

-- What only the bot and its owners see: corrections, claims with their status, stances and running jokes (bits).
-- user_id is the person a note is about (NULL for a chat-wide bit); user_ids lists everyone involved.
CREATE TABLE notes (
  id             serial PRIMARY KEY,
  chat_id        bigint NOT NULL,
  user_id        integer REFERENCES users(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('correction', 'claim', 'stance', 'bit')),
  about          text,
  value          text NOT NULL,
  value_norm     text NOT NULL,
  status         text CHECK (status IN ('open', 'done', 'dropped')),
  user_ids       integer[] NOT NULL DEFAULT '{}',
  topic_id       integer REFERENCES chronicle(id) ON DELETE SET NULL,
  confidence     real NOT NULL,
  source_msg_ids bigint[] NOT NULL DEFAULT '{}',
  said_at        timestamptz,
  superseded_by  integer REFERENCES notes(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  tsv            tsvector GENERATED ALWAYS AS (to_tsvector('russian', coalesce(about, '') || ' ' || value)) STORED
);
CREATE INDEX notes_chat_user ON notes (chat_id, user_id);
CREATE INDEX notes_tsv ON notes USING gin (tsv);
CREATE UNIQUE INDEX notes_unique_value ON notes (chat_id, coalesce(user_id, 0), kind, value_norm);

-- A debate is a chronicle topic of its own kind; its temperature (1–5) is computed from the messages, not by the model.
ALTER TABLE chronicle
  DROP CONSTRAINT chronicle_kind_check,
  ADD CONSTRAINT chronicle_kind_check CHECK (kind IN ('discussion', 'project', 'link', 'news', 'debate')),
  ADD COLUMN temperature smallint,
  ADD CONSTRAINT chronicle_temperature_check CHECK (temperature IS NULL OR (kind = 'debate' AND temperature BETWEEN 1 AND 5));

-- The bot may speak up uninvited when a recurring argument flares up again; an owner turns that off per chat.
ALTER TABLE chats ADD COLUMN interjections boolean NOT NULL DEFAULT true;

-- Every check of whether to speak up, spoken or not: the gaps and the daily cap are counted from here.
CREATE TABLE interjections (
  id         serial PRIMARY KEY,
  chat_id    bigint NOT NULL,
  theme_key  text NOT NULL,
  theme      text NOT NULL,
  msg_id     bigint,
  spoke      boolean NOT NULL,
  text       text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX interjections_chat_time ON interjections (chat_id, created_at);
