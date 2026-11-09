CREATE TABLE users (
  id               serial PRIMARY KEY,
  tg_id            bigint UNIQUE,
  username         text,
  display_name     text NOT NULL,
  tagline          text,
  tagline_manual   boolean NOT NULL DEFAULT false,
  is_admin         boolean NOT NULL DEFAULT false,
  opted_out        boolean NOT NULL DEFAULT false,
  dm_started       boolean NOT NULL DEFAULT false,
  first_seen_at    timestamptz,
  last_message_at  timestamptz,
  left_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_lower ON users (lower(username)) WHERE username IS NOT NULL;
CREATE INDEX users_display_name_lower ON users (lower(display_name));

CREATE TABLE messages (
  chat_id         bigint NOT NULL,
  msg_id          bigint NOT NULL,
  user_id         integer REFERENCES users(id) ON DELETE SET NULL,
  sent_at         timestamptz NOT NULL,
  text            text NOT NULL DEFAULT '',
  reply_to_msg_id bigint,
  is_forward      boolean NOT NULL DEFAULT false,
  forward_source  text,
  media_type      text,
  edited_at       timestamptz,
  extracted_at    timestamptz,
  tsv             tsvector GENERATED ALWAYS AS (to_tsvector('russian', coalesce(text, ''))) STORED,
  PRIMARY KEY (chat_id, msg_id)
);
CREATE INDEX messages_tsv ON messages USING gin (tsv);
CREATE INDEX messages_sent_at ON messages (sent_at);
CREATE INDEX messages_user ON messages (user_id, sent_at);
CREATE INDEX messages_pending ON messages (sent_at) WHERE extracted_at IS NULL;

CREATE TABLE projects (
  id                serial PRIMARY KEY,
  slug              text NOT NULL UNIQUE,
  name              text NOT NULL,
  tagline           text,
  status            text NOT NULL DEFAULT 'в работе'
                    CHECK (status IN ('идея', 'в работе', 'запущен', 'на паузе', 'заброшен')),
  stack             text[] NOT NULL DEFAULT '{}',
  links             jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence        real NOT NULL DEFAULT 1,
  hidden            boolean NOT NULL DEFAULT false,
  manual_fields     text[] NOT NULL DEFAULT '{}',
  first_seen_msg_id bigint,
  last_activity_at  timestamptz,
  source_msg_ids    bigint[] NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE project_members (
  project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE facts (
  id             serial PRIMARY KEY,
  user_id        integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           text NOT NULL
                 CHECK (kind IN ('role', 'stack', 'expertise', 'interest', 'project', 'link', 'timezone', 'looking_for', 'can_help')),
  value          text NOT NULL,
  value_norm     text NOT NULL,
  confidence     real NOT NULL,
  status         text NOT NULL DEFAULT 'auto' CHECK (status IN ('auto', 'manual', 'hidden', 'deprecated')),
  source_msg_ids bigint[] NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX facts_unique_value ON facts (user_id, kind, value_norm);

CREATE TABLE rejected_facts (
  user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL,
  value_norm text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind, value_norm)
);

CREATE TABLE votes (
  project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE links (
  id             serial PRIMARY KEY,
  url_norm       text NOT NULL UNIQUE,
  url            text NOT NULL,
  domain         text NOT NULL,
  first_user_id  integer REFERENCES users(id) ON DELETE SET NULL,
  first_msg_id   bigint,
  last_msg_id    bigint,
  share_count    integer NOT NULL DEFAULT 1,
  from_forward   boolean NOT NULL DEFAULT false,
  context        text,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  tsv            tsvector GENERATED ALWAYS AS (to_tsvector('simple', url || ' ' || coalesce(context, ''))) STORED
);
CREATE INDEX links_tsv ON links USING gin (tsv);

CREATE TABLE change_log (
  id             bigserial PRIMARY KEY,
  entity         text NOT NULL,
  entity_id      integer NOT NULL,
  op             text NOT NULL,
  before         jsonb,
  after          jsonb,
  source         text NOT NULL CHECK (source IN ('llm', 'user', 'admin', 'seed')),
  actor_user_id  integer REFERENCES users(id) ON DELETE SET NULL,
  source_msg_ids bigint[] NOT NULL DEFAULT '{}',
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX change_log_entity ON change_log (entity, entity_id, at DESC);

CREATE TABLE llm_usage (
  id                 bigserial PRIMARY KEY,
  at                 timestamptz NOT NULL DEFAULT now(),
  purpose            text NOT NULL,
  model              text NOT NULL,
  input_tokens       integer NOT NULL,
  output_tokens      integer NOT NULL,
  cache_read_tokens  integer NOT NULL DEFAULT 0,
  cache_write_tokens integer NOT NULL DEFAULT 0,
  cost_usd           numeric(10, 5) NOT NULL DEFAULT 0
);
CREATE INDEX llm_usage_at ON llm_usage (at);
