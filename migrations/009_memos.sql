-- Notes members write themselves: about themselves, or about a project they are an author of. Their own words, shown
-- on their card or on the project's page and read by the bot's answers. (The chronicler's private notes are `notes`.)
CREATE TABLE memos (
  id            bigserial PRIMARY KEY,
  chat_id       bigint NOT NULL,
  user_id       integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id    integer REFERENCES projects(id) ON DELETE CASCADE,
  text          text NOT NULL CHECK (length(text) BETWEEN 1 AND 300),
  source_msg_id bigint,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memos_author ON memos (chat_id, user_id, created_at DESC);
CREATE INDEX memos_project ON memos (project_id, created_at DESC) WHERE project_id IS NOT NULL;

-- A request in the chat writes them under the self-edit role (008): only the sender's own notes, and a project's only
-- as one of its authors, a project of the same chat that is not hidden. Reading project ids and authors is all it adds.
GRANT SELECT, INSERT, UPDATE, DELETE ON memos TO waggle_self_edit;
GRANT USAGE ON SEQUENCE memos_id_seq TO waggle_self_edit;
GRANT SELECT (project_id, user_id) ON project_members TO waggle_self_edit;
GRANT SELECT (id, chat_id, hidden) ON projects TO waggle_self_edit;
ALTER TABLE memos ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_memos ON memos TO waggle_self_edit
  USING (chat_id = self_edit_chat() AND user_id = self_edit_user())
  WITH CHECK (
    chat_id = self_edit_chat() AND user_id = self_edit_user()
    AND (project_id IS NULL OR EXISTS (
      SELECT 1 FROM project_members pm JOIN projects p ON p.id = pm.project_id
      WHERE pm.project_id = memos.project_id AND pm.user_id = self_edit_user() AND p.chat_id = self_edit_chat() AND NOT p.hidden)));
