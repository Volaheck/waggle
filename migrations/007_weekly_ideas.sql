-- Once a week the bot suggests one improvement to itself for a chat, from what the chat asked of it; owners decide.
ALTER TABLE chats ADD COLUMN ideas boolean NOT NULL DEFAULT true;

CREATE TABLE ideas (
  id bigserial PRIMARY KEY,
  chat_id bigint NOT NULL,
  title text NOT NULL,
  pitch text NOT NULL,
  why text NOT NULL,
  how text NOT NULL,
  effort text NOT NULL CHECK (effort IN ('small', 'medium', 'large')),
  evidence_msg_ids bigint[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'taken', 'declined', 'done')),
  msg_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);

CREATE INDEX ideas_chat ON ideas (chat_id, created_at DESC);
