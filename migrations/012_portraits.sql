-- A private portrait of one person's character, built from what they write and shown to them alone, in their private
-- chat with the bot (src/core/portrait.ts). Keyed by Telegram id: a person who connected the bot to their account may
-- never have written in a group with it. Nothing else in the bot reads these tables: not the Mini App, not answers in
-- the chat, not owners' commands.
CREATE TABLE portraits (
  tg_id             bigint PRIMARY KEY,
  status            text NOT NULL DEFAULT 'on' CHECK (status IN ('on', 'paused')),
  -- The latest portrait, section key → text, and how many observations it was written from.
  sections          jsonb,
  written_at        timestamptz,
  written_from      integer NOT NULL DEFAULT 0,
  -- Group messages newer than this have not been read yet. A new portrait starts with whatever text groups still keep.
  group_cursor      timestamptz NOT NULL DEFAULT now() - interval '30 days',
  read_at           timestamptz,
  -- How many of their own messages have been read, from private chats and from groups.
  read_dm           integer NOT NULL DEFAULT 0,
  read_group        integer NOT NULL DEFAULT 0,
  rebuild_asked_at  timestamptz,
  -- What this person's portrait cost this month (also recorded in llm_usage), for their own monthly cap.
  spend_month       date NOT NULL DEFAULT date_trunc('month', now())::date,
  spend_usd         numeric(10, 4) NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Their private chats as the bot sees them through Telegram Business, both sides, until they are read; then deleted.
CREATE TABLE portrait_lines (
  tg_id         bigint NOT NULL REFERENCES portraits(tg_id) ON DELETE CASCADE,
  chat_id       bigint NOT NULL,
  msg_id        bigint NOT NULL,
  from_subject  boolean NOT NULL,
  speaker       text NOT NULL,
  text          text NOT NULL,
  sent_at       timestamptz NOT NULL,
  PRIMARY KEY (tg_id, chat_id, msg_id)
);
CREATE INDEX portrait_lines_time ON portrait_lines (tg_id, sent_at);

-- What the messages showed about the person, with a short quote of their own words: the portrait is written from these.
CREATE TABLE portrait_observations (
  id         bigserial PRIMARY KEY,
  tg_id      bigint NOT NULL REFERENCES portraits(tg_id) ON DELETE CASCADE,
  area       text NOT NULL CHECK (area IN ('thinking', 'emotions', 'relationships', 'communication', 'drives', 'self_image', 'shadow', 'strengths', 'signals')),
  text       text NOT NULL,
  quote      text,
  strength   text NOT NULL CHECK (strength IN ('weak', 'moderate', 'strong')),
  setting    text NOT NULL CHECK (setting IN ('dm', 'group', 'both')),
  sources    integer NOT NULL,
  seen_from  timestamptz NOT NULL,
  seen_to    timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX portrait_observations_person ON portrait_observations (tg_id, id);
