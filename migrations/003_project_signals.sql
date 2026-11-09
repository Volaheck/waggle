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
