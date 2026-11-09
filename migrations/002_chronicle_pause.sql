-- The chronicler stops in a chat whose messages the model keeps refusing, until a bot owner resumes it.
-- Refusals before chronicle_resumed_at no longer count towards the next pause.
ALTER TABLE chats
  ADD COLUMN chronicle_paused_at  timestamptz,
  ADD COLUMN chronicle_pause_reason text,
  ADD COLUMN chronicle_resumed_at timestamptz;
