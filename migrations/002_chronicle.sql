-- Topic summaries written by the periodic extraction pass; /catchup reads them without calling the LLM.
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
  tsv          tsvector GENERATED ALWAYS AS (to_tsvector('russian', title || ' ' || summary)) STORED
);
CREATE INDEX chronicle_period ON chronicle (period_to DESC);
CREATE INDEX chronicle_tsv ON chronicle USING gin (tsv);

CREATE TABLE extraction_runs (
  id              serial PRIMARY KEY,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  messages_count  integer NOT NULL DEFAULT 0,
  first_msg_id    bigint,
  last_msg_id     bigint,
  status          text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  error           text,
  stats           jsonb
);

CREATE INDEX facts_tsv ON facts USING gin (to_tsvector('russian', value));
