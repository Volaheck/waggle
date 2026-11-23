-- What the bot last read of the public GitHub repository linked on a catalog project (src/worker/repos.ts): the date and
-- the titles of its latest commits, bots' left out, and its latest release. Never the code, the changes or who made them.
-- A row holds for the link it was read from: a project whose link changes is read again, and one that loses its link,
-- is hidden or has an author who stopped the bot's collecting about them loses its row.
CREATE TABLE project_repos (
  project_id   integer PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  link         text NOT NULL,
  -- owner/name as GitHub has it now (a renamed repository redirects); null when there is no public repository there.
  full_name    text,
  archived     boolean NOT NULL DEFAULT false,
  language     text,
  -- The last push to any branch, which tells whether there is anything new to read…
  pushed_at    timestamptz,
  -- …and the latest commit on the default branch that no bot made: the project's latest activity.
  committed_at timestamptz,
  -- Newest first, merges and bots' commits left out: [{ "sha", "title", "at" }].
  commits      jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- { "tag", "name", "at", "prerelease" }, or null when it has none.
  release      jsonb,
  checked_at   timestamptz NOT NULL DEFAULT now()
);
