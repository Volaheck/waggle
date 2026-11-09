-- A chronicle topic may be about one of the members' projects; the chronicler decides by meaning, not by a word match.
ALTER TABLE chronicle ADD COLUMN project_id integer REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX chronicle_project ON chronicle (project_id, period_to DESC) WHERE project_id IS NOT NULL;
