-- Waggle serves any number of group chats. Each chat is approved by a bot owner first, and everything
-- learned in a chat (cards, projects, chronicle, rating) stays in that chat: rows carry its chat_id.
-- Data imported before a chat existed carries chat_id = 0 until an owner attaches it to a real chat.

-- A person is one Telegram account (seeded cards have no tg_id until they are linked); their card lives per chat in members.
CREATE TABLE users (
  id               serial PRIMARY KEY,
  tg_id            bigint UNIQUE,
  username         text,
  display_name     text NOT NULL,
  is_admin         boolean NOT NULL DEFAULT false,
  dm_started       boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  current_chat_id  bigint
);
CREATE UNIQUE INDEX users_username_lower ON users (lower(username)) WHERE username IS NOT NULL;
CREATE INDEX users_display_name_lower ON users (lower(display_name));

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

-- The text (and forward_source) is cleared once a processed message is older than MESSAGE_RETENTION_DAYS; the row stays.
CREATE TABLE messages (
  chat_id         bigint NOT NULL,
  msg_id          bigint NOT NULL,
  user_id         integer REFERENCES users(id) ON DELETE SET NULL,
  sent_at         timestamptz NOT NULL,
  text            text NOT NULL DEFAULT '',
  reply_to_msg_id bigint,
  reply_to_bot    boolean NOT NULL DEFAULT false,
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

-- Status codes are the ones the chronicler reads and writes (PROJECT_STATUSES in src/core/projects.ts).
CREATE TABLE projects (
  id                serial PRIMARY KEY,
  slug              text NOT NULL,
  name              text NOT NULL,
  tagline           text,
  status            text NOT NULL DEFAULT 'in_progress'
                    CHECK (status IN ('idea', 'in_progress', 'launched', 'paused', 'abandoned')),
  stack             text[] NOT NULL DEFAULT '{}',
  links             jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence        real NOT NULL DEFAULT 1,
  hidden            boolean NOT NULL DEFAULT false,
  manual_fields     text[] NOT NULL DEFAULT '{}',
  first_seen_msg_id bigint,
  last_activity_at  timestamptz,
  source_msg_ids    bigint[] NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  chat_id           bigint NOT NULL
);
CREATE UNIQUE INDEX projects_chat_slug ON projects (chat_id, slug);

-- role: what each author did on the project ("backend", "design", …).
CREATE TABLE project_members (
  project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text,
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE votes (
  project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

-- What the chronicler noticed about a project: feedback, real usage, releases. Feeds the project rating.
CREATE TABLE project_signals (
  id             serial PRIMARY KEY,
  project_id     integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id        integer REFERENCES users(id) ON DELETE SET NULL,
  kind           text NOT NULL CHECK (kind IN ('praise', 'critique', 'usage', 'contribution', 'interest', 'milestone')),
  impact         smallint NOT NULL CHECK (impact BETWEEN 1 AND 5),
  note           text NOT NULL,
  source_msg_ids bigint[] NOT NULL DEFAULT '{}',
  happened_at    timestamptz NOT NULL,
  run_id         integer,
  hidden         boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_signals_project ON project_signals (project_id, happened_at DESC);
CREATE INDEX project_signals_dedupe ON project_signals (project_id, user_id, kind, happened_at);

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
  updated_at     timestamptz NOT NULL DEFAULT now(),
  chat_id        bigint NOT NULL
);
CREATE UNIQUE INDEX facts_unique_value ON facts (chat_id, user_id, kind, value_norm);
CREATE INDEX facts_chat_user ON facts (chat_id, user_id);
CREATE INDEX facts_tsv ON facts USING gin (to_tsvector('russian', value));

-- Facts people removed as wrong: the chronicler may never add them again, even reworded.
CREATE TABLE rejected_facts (
  user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL,
  value_norm text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  chat_id    bigint NOT NULL,
  PRIMARY KEY (chat_id, user_id, kind, value_norm)
);

-- Topic summaries written by the chronicler; /catchup reads them without calling the LLM.
-- importance: 1 = a trifle, 5 = the event of the week. project_id: the members' project the topic is about,
-- decided by meaning, not by a word match.
CREATE TABLE chronicle (
  id           serial PRIMARY KEY,
  run_id       integer NOT NULL,
  period_from  timestamptz NOT NULL,
  period_to    timestamptz NOT NULL,
  title        text NOT NULL,
  summary      text NOT NULL,
  kind         text NOT NULL DEFAULT 'discussion' CHECK (kind IN ('discussion', 'project', 'link', 'news')),
  msg_ids      bigint[] NOT NULL DEFAULT '{}',
  user_ids     integer[] NOT NULL DEFAULT '{}',
  heat         integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  tsv          tsvector GENERATED ALWAYS AS (to_tsvector('russian', title || ' ' || summary)) STORED,
  importance   smallint NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  project_id   integer REFERENCES projects(id) ON DELETE SET NULL,
  chat_id      bigint NOT NULL
);
CREATE INDEX chronicle_period ON chronicle (period_to DESC);
CREATE INDEX chronicle_tsv ON chronicle USING gin (tsv);
CREATE INDEX chronicle_rank ON chronicle (importance DESC, heat DESC, period_to DESC);
CREATE INDEX chronicle_project ON chronicle (project_id, period_to DESC) WHERE project_id IS NOT NULL;
CREATE INDEX chronicle_chat_period ON chronicle (chat_id, period_to DESC);

CREATE TABLE extraction_runs (
  id              serial PRIMARY KEY,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  messages_count  integer NOT NULL DEFAULT 0,
  first_msg_id    bigint,
  last_msg_id     bigint,
  status          text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  error           text,
  stats           jsonb,
  chat_id         bigint NOT NULL
);

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
  cost_usd           numeric(10, 5) NOT NULL DEFAULT 0,
  chat_id            bigint
);
CREATE INDEX llm_usage_at ON llm_usage (at);

-- Small key/value store for background jobs (when cards were last cleaned up, skipped messages, …).
CREATE TABLE app_state (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
