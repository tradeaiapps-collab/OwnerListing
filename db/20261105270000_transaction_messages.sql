-- In-platform messaging. Two kinds of thread share one message store:
--   transaction: one per settlement (its id IS the settlement id) for the buyer, owner and appointed agent;
--   channel: fixed staff team channels (#general, #inspections, #disputes, #finance, #management), gated by staff permission in code.
-- Permanent record: messages are never edited or deleted (CLAUDE.md rule, same as agent_message). Editing, attachments and exports are later work.
CREATE TABLE message_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('transaction','channel')),
  settlement_id UUID UNIQUE REFERENCES settlement_timeline(id),
  channel TEXT UNIQUE CHECK (channel IN ('general','inspections','disputes','finance','management')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((kind = 'transaction' AND settlement_id IS NOT NULL AND id = settlement_id AND channel IS NULL) OR (kind = 'channel' AND settlement_id IS NULL AND channel IS NOT NULL))
);
INSERT INTO message_threads (kind, channel) VALUES ('channel','general'),('channel','inspections'),('channel','disputes'),('channel','finance'),('channel','management');

CREATE TABLE transaction_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES message_threads(id),
  sender_id UUID REFERENCES app_user(id),
  message_type TEXT NOT NULL CHECK (message_type IN ('text','mention','system')),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  mentions TEXT[] NOT NULL DEFAULT '{}' CHECK (mentions <@ ARRAY['buyer','seller','agent']::text[]),
  reply_to_id UUID REFERENCES transaction_messages(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((message_type = 'system') = (sender_id IS NULL))
);
CREATE INDEX transaction_messages_thread_idx ON transaction_messages(thread_id, created_at, id);
CREATE INDEX transaction_messages_sender_idx ON transaction_messages(sender_id, created_at);

CREATE FUNCTION reject_transaction_message_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'transaction_messages is a permanent record';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER transaction_messages_no_update_delete
  BEFORE UPDATE OR DELETE ON transaction_messages
  FOR EACH ROW EXECUTE FUNCTION reject_transaction_message_mutation();

-- Per person per thread: how far they have read, and whether they muted it.
CREATE TABLE message_participants (
  thread_id UUID NOT NULL REFERENCES message_threads(id),
  user_id UUID NOT NULL REFERENCES app_user(id),
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT 'epoch',
  muted BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (thread_id, user_id)
);

-- Per transaction thread: archived after settlement or a fall-through. An archived thread stays readable but takes no new messages.
CREATE TABLE thread_settings (
  thread_id UUID PRIMARY KEY REFERENCES message_threads(id),
  archived_at TIMESTAMPTZ,
  archived_by UUID REFERENCES app_user(id)
);
