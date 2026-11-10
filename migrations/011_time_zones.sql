-- A member's time zone, an IANA name such as Asia/Jakarta, kept on their card in each chat like the rest of it. They
-- set it themselves in the chat ('chat') or the Mini App ('app'); the Mini App also takes it from their device
-- ('device') onto a card that never had one (time_zone_set_at stays set when they clear it), and never replaces one they
-- chose. Without one, their clock follows the place on their card, else the chat's zone (src/core/zones.ts). A chat
-- edit writes it under the self-edit role (008), on their own row only.
ALTER TABLE members
  ADD COLUMN time_zone text,
  ADD COLUMN time_zone_source text CHECK (time_zone_source IN ('chat', 'app', 'device')),
  ADD COLUMN time_zone_set_at timestamptz,
  ADD CONSTRAINT members_time_zone_with_source CHECK ((time_zone IS NULL) = (time_zone_source IS NULL));
GRANT UPDATE (time_zone, time_zone_source, time_zone_set_at) ON members TO waggle_self_edit;

-- The time zones a place on a card stands for, worked out once: one for a city, several for a country that spans
-- them, none for words that name no place. NULL until then.
ALTER TABLE facts ADD COLUMN zones text[];

-- The bot asked which city the sender is in (their place spans several time zones): a reply to that message answers it.
ALTER TABLE self_edits ADD COLUMN asked_city text;
