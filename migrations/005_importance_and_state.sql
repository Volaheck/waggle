-- How much a chronicle topic matters (1 = мелочь, 5 = событие недели); the chronicle tab shows the top.
ALTER TABLE chronicle ADD COLUMN importance smallint NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5);
CREATE INDEX chronicle_rank ON chronicle (importance DESC, heat DESC, period_to DESC);

-- Small key/value store for background jobs (e.g. when cards were last consolidated).
CREATE TABLE app_state (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
