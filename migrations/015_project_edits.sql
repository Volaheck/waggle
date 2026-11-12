-- A project's authors change its tagline, status, stack and links by asking the bot in the chat: the same edit as the
-- Mini App's (src/core/projects.ts editProject), written under the self-edit role (008) like every chat write. Its
-- grants let it read what that edit reads and write only those columns, manual_fields (so the chronicler leaves them
-- alone) and updated_at; the name, the slug, the authors, hiding and the chronicler's own columns stay out of its reach.
-- Row-level security keeps it to the projects of the subject's chat that the subject is an author of: it reads only
-- those (the policy on memos and the Undo of a note look them up too) and changes only those that are shown. The app's
-- own role owns the table and is not affected.
GRANT SELECT (tagline, status, stack, links, manual_fields) ON projects TO waggle_self_edit;
GRANT UPDATE (tagline, status, stack, links, manual_fields, updated_at) ON projects TO waggle_self_edit;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_projects_read ON projects FOR SELECT TO waggle_self_edit
  USING (
    chat_id = self_edit_chat()
    AND EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = projects.id AND pm.user_id = self_edit_user()));
CREATE POLICY own_projects_edit ON projects FOR UPDATE TO waggle_self_edit
  USING (
    chat_id = self_edit_chat() AND NOT hidden
    AND EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = projects.id AND pm.user_id = self_edit_user()))
  WITH CHECK (
    chat_id = self_edit_chat() AND NOT hidden
    AND EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = projects.id AND pm.user_id = self_edit_user()));
-- The project's history it writes is that edit, or the Undo of one, of a project it may change: never a rename, a
-- merge, a hide or a row about anyone else's project, which the app reads for former names, old slugs, merges and the
-- dates of a status. Restrictive, so it holds on top of the insert policy of 008.
CREATE POLICY own_project_history ON change_log AS RESTRICTIVE FOR INSERT TO waggle_self_edit
  WITH CHECK (
    entity <> 'project'
    OR (op IN ('update', 'undo') AND EXISTS (
      SELECT 1 FROM projects p JOIN project_members pm ON pm.project_id = p.id
      WHERE p.id = change_log.entity_id AND p.chat_id = self_edit_chat() AND NOT p.hidden AND pm.user_id = self_edit_user())));
