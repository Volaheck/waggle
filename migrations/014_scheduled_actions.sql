-- A member also asks the bot to do something for them at a later time, anything it does when asked («через 2 часа
-- поставь мне статус «в отпуске»», «завтра в 9 расскажи, что обсуждали ночью», «в понедельник в 9 /top»): it is read
-- with the reminders (src/bot/reminders.ts), waits in `reminders` as an action, and at its time src/bot/later.ts does it
-- as if they had just asked. Its text is what to do, in their own words.
ALTER TABLE reminders ADD COLUMN kind text NOT NULL DEFAULT 'remind' CHECK (kind IN ('remind', 'action'));
-- The message the request replied to («через неделю закинь это в заметки»), which the action replies to again. Its text
-- is kept here only when it is the bot's own message or the requester's own; another member's words are read from
-- `messages` when the action is due, while the chat still keeps them, so the retention and /forgetme reach them as ever.
ALTER TABLE reminders
  ADD COLUMN reply_to_msg_id bigint,
  ADD COLUMN reply_text text CHECK (length(reply_text) BETWEEN 1 AND 3500),
  ADD COLUMN reply_author text CHECK (reply_author IN ('bot', 'self')),
  ADD CONSTRAINT reminders_reply_kept CHECK ((reply_text IS NULL) = (reply_author IS NULL) AND (reply_text IS NULL OR reply_to_msg_id IS NOT NULL));
-- The self-edit role adds an action as a pending row of the subject's own, like a reminder (013): the policies stay as they
-- were, and it still can neither send, move nor rewrite one.
GRANT INSERT (kind, reply_to_msg_id, reply_text, reply_author) ON reminders TO waggle_self_edit;

-- An action done at its time is on record in self_edits under an id no message has (executionMsgId in
-- src/core/member-reminders.ts), so it never meets the record of the request that asked for it, and a second try of it
-- finds it there. This is the message that asked for it, which its replies answer and its changes name as their source.
ALTER TABLE self_edits ADD COLUMN source_msg_id bigint;
