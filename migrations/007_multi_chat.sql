-- Waggle serves any number of group chats. Each chat is approved by a bot owner first,
-- and everything learned in a chat (cards, projects, chronicle, rating) stays in that chat.
-- Rows that existed before this migration belong to a single chat whose ID was not stored;
-- they get chat_id = 0 until an owner attaches them to a real chat.

CREATE TABLE chats (
  id                 bigint PRIMARY KEY,
  title              text,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'left')),
  added_by           bigint,
  decided_by         bigint,
  decided_at         timestamptz,
  monthly_budget_usd numeric(8, 2),
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- A person is one Telegram account; their card lives per chat.
CREATE TABLE members (
  chat_id         bigint NOT NULL,
  user_id         integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tagline         text,
  tagline_manual  boolean NOT NULL DEFAULT false,
  opted_out       boolean NOT NULL DEFAULT false,
  first_seen_at   timestamptz,
  last_message_at timestamptz,
  left_at         timestamptz,
  PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX members_user ON members (user_id);

INSERT INTO members (chat_id, user_id, tagline, tagline_manual, opted_out, first_seen_at, last_message_at, left_at)
SELECT 0, id, tagline, tagline_manual, opted_out, first_seen_at, last_message_at, left_at FROM users;

ALTER TABLE users
  DROP COLUMN tagline,
  DROP COLUMN tagline_manual,
  DROP COLUMN opted_out,
  DROP COLUMN first_seen_at,
  DROP COLUMN last_message_at,
  DROP COLUMN left_at,
  ADD COLUMN current_chat_id bigint;

ALTER TABLE facts ADD COLUMN chat_id bigint NOT NULL DEFAULT 0;
ALTER TABLE facts ALTER COLUMN chat_id DROP DEFAULT;
DROP INDEX facts_unique_value;
CREATE UNIQUE INDEX facts_unique_value ON facts (chat_id, user_id, kind, value_norm);
CREATE INDEX facts_chat_user ON facts (chat_id, user_id);

ALTER TABLE rejected_facts ADD COLUMN chat_id bigint NOT NULL DEFAULT 0;
ALTER TABLE rejected_facts ALTER COLUMN chat_id DROP DEFAULT;
ALTER TABLE rejected_facts DROP CONSTRAINT rejected_facts_pkey;
ALTER TABLE rejected_facts ADD PRIMARY KEY (chat_id, user_id, kind, value_norm);

ALTER TABLE projects ADD COLUMN chat_id bigint NOT NULL DEFAULT 0;
ALTER TABLE projects ALTER COLUMN chat_id DROP DEFAULT;
ALTER TABLE projects DROP CONSTRAINT projects_slug_key;
CREATE UNIQUE INDEX projects_chat_slug ON projects (chat_id, slug);

ALTER TABLE chronicle ADD COLUMN chat_id bigint NOT NULL DEFAULT 0;
ALTER TABLE chronicle ALTER COLUMN chat_id DROP DEFAULT;
CREATE INDEX chronicle_chat_period ON chronicle (chat_id, period_to DESC);

ALTER TABLE extraction_runs ADD COLUMN chat_id bigint NOT NULL DEFAULT 0;
ALTER TABLE extraction_runs ALTER COLUMN chat_id DROP DEFAULT;

ALTER TABLE links ADD COLUMN chat_id bigint NOT NULL DEFAULT 0;
ALTER TABLE links ALTER COLUMN chat_id DROP DEFAULT;
ALTER TABLE links DROP CONSTRAINT links_url_norm_key;
CREATE UNIQUE INDEX links_chat_url ON links (chat_id, url_norm);

ALTER TABLE llm_usage ADD COLUMN chat_id bigint;
