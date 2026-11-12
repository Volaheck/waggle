-- Wishes: a member asks the bot not to write something, or not to write in some way, and it keeps to that from then on
-- (src/core/wishes.ts). One for themselves ('self') is about how it writes to them or about them («не шути про мой вес»,
-- «пиши мне короче»); one for the whole chat ('chat'), which only the chat's Telegram admins and the bot's owners ask
-- for, is about what it writes there at all («не пиши в этом чате про политику»). The text is the member's own words.
CREATE TABLE wishes (
  id            bigserial PRIMARY KEY,
  chat_id       bigint NOT NULL,
  user_id       integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope         text NOT NULL CHECK (scope IN ('self', 'chat')),
  text          text NOT NULL CHECK (length(text) BETWEEN 1 AND 300),
  source_msg_id bigint,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wishes_member ON wishes (chat_id, user_id, created_at);
CREATE INDEX wishes_chat_wide ON wishes (chat_id, created_at) WHERE scope = 'chat';

-- A request in the chat writes them under the self-edit role (008): it adds and deletes the subject's own wishes in the
-- subject's chat, and reads those and the chat's wishes for everyone, whose cap and twins it checks. A wish for everyone
-- is the chat's: the role may also take one back in the subject's chat, and put back as it was one it took. Who may ask
-- for one, or take one back, is checked in code, which alone can ask Telegram who the chat's admins are. Their words
-- never go into change_log, so /forgetme erases them for good.
GRANT SELECT, INSERT, DELETE ON wishes TO waggle_self_edit;
GRANT USAGE ON SEQUENCE wishes_id_seq TO waggle_self_edit;
ALTER TABLE wishes ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_wishes ON wishes TO waggle_self_edit
  USING (chat_id = self_edit_chat() AND user_id = self_edit_user())
  WITH CHECK (chat_id = self_edit_chat() AND user_id = self_edit_user());
CREATE POLICY chat_wishes_read ON wishes FOR SELECT TO waggle_self_edit
  USING (chat_id = self_edit_chat() AND scope = 'chat');
CREATE POLICY chat_wishes_lift ON wishes FOR DELETE TO waggle_self_edit
  USING (chat_id = self_edit_chat() AND scope = 'chat');
CREATE POLICY chat_wishes_restore ON wishes FOR INSERT TO waggle_self_edit
  WITH CHECK (chat_id = self_edit_chat() AND scope = 'chat');
