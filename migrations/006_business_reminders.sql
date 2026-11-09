-- Both sides of an owner's connected private chats, kept briefly so the model can find promises and plans in them.
CREATE TABLE business_dialogue (
  connection_id text NOT NULL REFERENCES business_connections (id) ON DELETE CASCADE,
  chat_id bigint NOT NULL,
  msg_id bigint NOT NULL,
  from_owner boolean NOT NULL,
  chat_name text NOT NULL,
  text text NOT NULL,
  sent_at timestamptz NOT NULL,
  processed boolean NOT NULL DEFAULT false,
  PRIMARY KEY (connection_id, chat_id, msg_id)
);

CREATE INDEX business_dialogue_pending ON business_dialogue (connection_id, chat_id, sent_at) WHERE NOT processed;
CREATE INDEX business_dialogue_sent_at ON business_dialogue (sent_at);

CREATE TABLE business_reminders (
  id bigserial PRIMARY KEY,
  connection_id text NOT NULL REFERENCES business_connections (id) ON DELETE CASCADE,
  chat_id bigint NOT NULL,
  chat_name text NOT NULL,
  -- promise: someone committed to do something; plan: an agreed meeting, call or event.
  kind text NOT NULL CHECK (kind IN ('promise', 'plan')),
  -- Who committed: the owner, the other person, or both (a plan).
  committed_by text NOT NULL CHECK (committed_by IN ('me', 'them', 'both')),
  what text NOT NULL,
  due_at timestamptz,
  due_has_time boolean NOT NULL DEFAULT false,
  remind_at timestamptz NOT NULL,
  -- open: waits for remind_at; sent: the owner got it; done / dropped: the owner closed it, or the chat showed it done.
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'sent', 'done', 'dropped')),
  source_msg_id bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX business_reminders_due ON business_reminders (remind_at) WHERE status = 'open';
CREATE INDEX business_reminders_chat ON business_reminders (connection_id, chat_id) WHERE status IN ('open', 'sent');
