-- Reminders a member asks the bot for in a chat («напомни завтра в 10 позвонить в банк»), for themselves only:
-- src/bot/reminders.ts reads the request, src/core/reminders.ts works out when it is due in the member's own time zone,
-- and src/worker/member-reminders.ts writes to them then, in the chat and in their private chat with the bot.
CREATE TABLE reminders (
  id             bigserial PRIMARY KEY,
  chat_id        bigint NOT NULL,
  user_id        integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text           text NOT NULL CHECK (length(text) BETWEEN 1 AND 500),
  due_at         timestamptz NOT NULL,
  -- The zone the due time was worked out in, as the receipt named it.
  time_zone      text NOT NULL,
  -- The chat's language when it was asked for: the receipt's, and the reminder's when it comes, maybe months later.
  language       text NOT NULL DEFAULT 'English' CHECK (language IN ('Russian', 'English')),
  -- The request, and the forum topic it was asked in.
  source_msg_id  bigint NOT NULL,
  thread_id      bigint,
  receipt_msg_id bigint,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'cancelled', 'failed')),
  attempts       integer NOT NULL DEFAULT 0,
  claimed_at     timestamptz,
  -- What went out where: once one is set, that place never gets the reminder again.
  chat_msg_id    bigint,
  dm_msg_id      bigint,
  dm_error       text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  sent_at        timestamptz,
  cancelled_at   timestamptz
);
CREATE INDEX reminders_due ON reminders (due_at) WHERE status = 'pending';
CREATE INDEX reminders_member ON reminders (chat_id, user_id, due_at) WHERE status = 'pending';

-- A request in the chat writes under the self-edit role (008), confined to the subject's rows in the subject's chat: it
-- reads their reminders, adds one as a new pending reminder (status, attempts and delivery columns keep their defaults)
-- and cancels a pending one; it can neither send nor move one. The delivery worker runs under the app's own role.
GRANT SELECT ON reminders TO waggle_self_edit;
GRANT INSERT (chat_id, user_id, text, due_at, time_zone, language, source_msg_id, thread_id) ON reminders TO waggle_self_edit;
GRANT UPDATE (status, cancelled_at, receipt_msg_id) ON reminders TO waggle_self_edit;
GRANT USAGE ON SEQUENCE reminders_id_seq TO waggle_self_edit;
ALTER TABLE reminders ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_reminders_read ON reminders FOR SELECT TO waggle_self_edit
  USING (chat_id = self_edit_chat() AND user_id = self_edit_user());
CREATE POLICY own_reminders_add ON reminders FOR INSERT TO waggle_self_edit
  WITH CHECK (chat_id = self_edit_chat() AND user_id = self_edit_user() AND status = 'pending');
CREATE POLICY own_reminders_cancel ON reminders FOR UPDATE TO waggle_self_edit
  USING (chat_id = self_edit_chat() AND user_id = self_edit_user() AND status = 'pending')
  WITH CHECK (chat_id = self_edit_chat() AND user_id = self_edit_user() AND status IN ('pending', 'cancelled'));
