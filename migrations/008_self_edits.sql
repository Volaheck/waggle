-- A member asks the bot to change their own card; src/core/own-card.ts applies it. Each request message is handled once.
CREATE TABLE self_edits (
  id             bigserial PRIMARY KEY,
  chat_id        bigint NOT NULL,
  msg_id         bigint NOT NULL,
  user_id        integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tg_id          bigint NOT NULL,
  kind           text NOT NULL DEFAULT 'parsing',
  status         text NOT NULL DEFAULT 'parsing' CHECK (status IN ('parsing', 'proposed', 'applied', 'undone', 'refused', 'answered', 'failed')),
  plan           jsonb,
  applied        jsonb,
  receipt_msg_id bigint,
  created_at     timestamptz NOT NULL DEFAULT now(),
  decided_at     timestamptz,
  UNIQUE (chat_id, msg_id)
);
CREATE INDEX self_edits_member ON self_edits (chat_id, user_id, created_at DESC);

-- How an account came to own an imported card: NULL for its own card, 'owner' after /link, 'name' or 'username' when
-- it was claimed automatically. A card claimed automatically cannot be edited from the chat until an owner links it.
ALTER TABLE users ADD COLUMN linked_by text CHECK (linked_by IN ('owner', 'name', 'username'));

-- The only role chat edits run under (SET LOCAL ROLE inside their transaction): it may touch nothing but these tables,
-- and row-level security limits it to the one member and chat the transaction names. The app's own role owns the
-- tables and is not affected; anything not granted here is refused.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'waggle_self_edit') THEN
    CREATE ROLE waggle_self_edit NOLOGIN;
  END IF;
END
$$;
GRANT waggle_self_edit TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO waggle_self_edit;
GRANT SELECT, INSERT, UPDATE, DELETE ON facts, rejected_facts, aliases, self_edits TO waggle_self_edit;
GRANT SELECT, UPDATE (tagline, tagline_manual) ON members TO waggle_self_edit;
GRANT INSERT ON change_log TO waggle_self_edit;
GRANT USAGE ON SEQUENCE facts_id_seq, aliases_id_seq, change_log_id_seq, self_edits_id_seq TO waggle_self_edit;

CREATE FUNCTION self_edit_chat() RETURNS bigint LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('waggle.chat', true), '')::bigint $$;
CREATE FUNCTION self_edit_user() RETURNS integer LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('waggle.user', true), '')::integer $$;

ALTER TABLE facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE rejected_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE members ENABLE ROW LEVEL SECURITY;
ALTER TABLE change_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE self_edits ENABLE ROW LEVEL SECURITY;

CREATE POLICY own_card ON facts TO waggle_self_edit
  USING (chat_id = self_edit_chat() AND user_id = self_edit_user()) WITH CHECK (chat_id = self_edit_chat() AND user_id = self_edit_user());
CREATE POLICY own_card ON rejected_facts TO waggle_self_edit
  USING (chat_id = self_edit_chat() AND user_id = self_edit_user()) WITH CHECK (chat_id = self_edit_chat() AND user_id = self_edit_user());
CREATE POLICY own_card ON aliases TO waggle_self_edit
  USING (chat_id = self_edit_chat() AND user_id = self_edit_user()) WITH CHECK (chat_id = self_edit_chat() AND user_id = self_edit_user() AND project_id IS NULL);
CREATE POLICY own_card ON members TO waggle_self_edit
  USING (chat_id = self_edit_chat() AND user_id = self_edit_user()) WITH CHECK (chat_id = self_edit_chat() AND user_id = self_edit_user());
CREATE POLICY own_card ON change_log FOR INSERT TO waggle_self_edit WITH CHECK (actor_user_id = self_edit_user() AND source = 'user');
CREATE POLICY own_card ON self_edits TO waggle_self_edit
  USING (chat_id = self_edit_chat() AND user_id = self_edit_user()) WITH CHECK (chat_id = self_edit_chat() AND user_id = self_edit_user());
