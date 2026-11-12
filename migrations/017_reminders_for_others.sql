-- A reminder a member asks the bot to give other members of the chat, by name or @username («напомни Оле через час
-- ответить мне», «напомни @kit завтра в 10 сдать отчёт»): it stays its asker's, who alone sees, lists and cancels
-- it, and when it is due the bot writes in the chat, tagging those members (src/bot/reminders.ts). At most three of
-- them, never the whole chat. `for_asker`: the asker is reminded too («напомни мне и Кате»), in the chat and privately,
-- as with a reminder of their own; a reminder for others only is never sent privately to anyone.
ALTER TABLE reminders
  ADD COLUMN for_user_ids integer[] NOT NULL DEFAULT '{}' CHECK (cardinality(for_user_ids) <= 3),
  ADD COLUMN for_asker boolean NOT NULL DEFAULT true,
  ADD CONSTRAINT reminders_others_reminded CHECK (cardinality(for_user_ids) = 0 OR kind = 'remind');
GRANT INSERT (for_user_ids, for_asker) ON reminders TO waggle_self_edit;
