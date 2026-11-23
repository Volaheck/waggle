-- The notes the bot posts in a chat when it learns something new (src/worker/announcements.ts): the capabilities the
-- post tells of and those a wish of the chat ruled out, by their keys in src/core/capabilities.ts, what it said, and
-- how it went. Both count as told, unless the note failed: then it told of nothing, and its news is the next day's.
ALTER TABLE chats ADD COLUMN announcements boolean NOT NULL DEFAULT true;

CREATE TABLE announcements (
  id           bigserial PRIMARY KEY,
  chat_id      bigint NOT NULL,
  capabilities text[] NOT NULL,
  ruled_out    text[] NOT NULL DEFAULT '{}',
  text         text,
  status       text NOT NULL CHECK (status IN ('pending', 'sending', 'posted', 'failed', 'held_back')),
  reason       text,
  attempts     integer NOT NULL DEFAULT 0,
  msg_id       bigint,
  created_at   timestamptz NOT NULL DEFAULT now(),
  posted_at    timestamptz
);
CREATE INDEX announcements_chat ON announcements (chat_id, created_at);
