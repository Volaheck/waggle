-- An owner connects the bot to their own Telegram account (Telegram Business → Chat Automation). The bot then keeps
-- the other side's messages in those private chats for a while, so it can show the owner what was deleted or edited.
CREATE TABLE business_connections (
  id text PRIMARY KEY,
  owner_tg_id bigint NOT NULL,
  -- The owner's private chat with the bot, where the reports go.
  owner_chat_id bigint NOT NULL,
  enabled boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE business_messages (
  connection_id text NOT NULL REFERENCES business_connections (id) ON DELETE CASCADE,
  chat_id bigint NOT NULL,
  msg_id bigint NOT NULL,
  from_tg_id bigint,
  from_name text NOT NULL,
  text text NOT NULL DEFAULT '',
  media_kind text,
  file_id text,
  sent_at timestamptz NOT NULL,
  edited_at timestamptz,
  PRIMARY KEY (connection_id, chat_id, msg_id)
);

CREATE INDEX business_messages_sent_at ON business_messages (sent_at);
