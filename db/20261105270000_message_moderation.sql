-- Elena message moderation: compliance and tone flags on messages sent by the seller side (owner or appointed agent).
-- Messages are never blocked, changed or deleted here. A flag is a note for staff; staff record one decision on it.
CREATE TABLE message_moderation_flag (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enquiry_id UUID NOT NULL REFERENCES enquiry(id),
  message_id UUID NOT NULL UNIQUE REFERENCES enquiry_message(id),
  sender_user_id UUID NOT NULL REFERENCES app_user(id),
  severity TEXT NOT NULL CHECK (severity IN ('low','medium','high')),
  tone TEXT NOT NULL CHECK (tone IN ('neutral','frustrated','aggressive')),
  categories TEXT[] NOT NULL CHECK (cardinality(categories) >= 1),
  flags JSONB NOT NULL,
  rules_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','approved','revision_requested','educated')),
  reviewed_by UUID REFERENCES app_user(id),
  reviewed_at TIMESTAMPTZ,
  review_note TEXT CHECK (review_note IS NULL OR char_length(review_note) BETWEEN 1 AND 500),
  CHECK ((status = 'open') = (reviewed_at IS NULL) AND (reviewed_at IS NULL) = (reviewed_by IS NULL))
);
CREATE INDEX message_moderation_flag_queue_idx ON message_moderation_flag(created_at) WHERE status = 'open';
CREATE INDEX message_moderation_flag_sender_idx ON message_moderation_flag(sender_user_id, created_at);
CREATE INDEX message_moderation_flag_enquiry_idx ON message_moderation_flag(enquiry_id, created_at);

-- Only the review columns move, once. Flags are never deleted.
CREATE OR REPLACE FUNCTION message_moderation_flag_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'message_moderation_flag is a permanent record'; END IF;
  IF OLD.reviewed_at IS NOT NULL THEN RAISE EXCEPTION 'message_moderation_flag already reviewed'; END IF;
  IF NEW.enquiry_id <> OLD.enquiry_id OR NEW.message_id <> OLD.message_id OR NEW.sender_user_id <> OLD.sender_user_id
     OR NEW.severity <> OLD.severity OR NEW.tone <> OLD.tone OR NEW.categories <> OLD.categories OR NEW.flags <> OLD.flags
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'message_moderation_flag result cannot change';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER message_moderation_flag_guard_trg BEFORE UPDATE OR DELETE ON message_moderation_flag FOR EACH ROW EXECUTE FUNCTION message_moderation_flag_guard();
