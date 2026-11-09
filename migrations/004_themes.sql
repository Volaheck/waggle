-- The themes a chat keeps coming back to: the model groups the chronicle's topics into them once a day, each with the
-- words that bring it up. The interjector and the answer context read them.
CREATE TABLE themes (
  id         serial PRIMARY KEY,
  chat_id    bigint NOT NULL,
  title      text NOT NULL,
  keywords   text[] NOT NULL,
  topic_ids  integer[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX themes_chat ON themes (chat_id);
