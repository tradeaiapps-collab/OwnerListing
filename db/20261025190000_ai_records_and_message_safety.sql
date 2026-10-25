-- Shared AI pipeline records (spec 3.2 020_ai_records, adapted to Build 001 tables) and the inbound message safety filter.

-- Every AI draft, with what produced it, so any message can be reproduced (spec 5.1 "Log").
-- The text is the draft as written by the AI (footer included). What the owner finally sent is in enquiry_message.
CREATE TABLE ai_draft (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('enquiry_reply','offer_response')),
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  enquiry_id UUID REFERENCES enquiry(id),
  offer_id UUID REFERENCES formal_offer(id),
  action TEXT CHECK (action IN ('draft_reply','request_information','recommend_counter','reject')),
  intent TEXT CHECK (intent IN ('availability','inspection','price','documents','offer','complaint','other')),
  text TEXT NOT NULL CHECK (char_length(text) BETWEEN 1 AND 5000),
  policy_decision JSONB NOT NULL,
  guard_result JSONB NOT NULL,
  engine_id TEXT NOT NULL,
  model_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  input_hash CHAR(64) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','edited_sent','discarded','held')),
  created_by UUID NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_by UUID REFERENCES app_user(id),
  finished_at TIMESTAMPTZ,
  sent_message_id UUID REFERENCES enquiry_message(id),
  CHECK (kind <> 'enquiry_reply' OR enquiry_id IS NOT NULL),
  CHECK (kind <> 'offer_response' OR offer_id IS NOT NULL),
  CHECK ((status IN ('pending','held')) = (finished_at IS NULL))
);
CREATE INDEX ai_draft_enquiry_idx ON ai_draft(enquiry_id, created_at DESC);
CREATE INDEX ai_draft_offer_idx ON ai_draft(offer_id, created_at DESC);

-- A draft's content and provenance never change; only its status moves once, from pending/held to a final state.
CREATE OR REPLACE FUNCTION ai_draft_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'ai_draft is a permanent record'; END IF;
  IF NEW.text <> OLD.text OR NEW.input_hash <> OLD.input_hash OR NEW.prompt_version <> OLD.prompt_version
     OR NEW.model_version <> OLD.model_version OR NEW.engine_id <> OLD.engine_id OR NEW.kind <> OLD.kind
     OR NEW.listing_id <> OLD.listing_id OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'ai_draft content cannot change';
  END IF;
  IF OLD.status NOT IN ('pending','held') THEN RAISE EXCEPTION 'ai_draft is already final'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ai_draft_guard_trg BEFORE UPDATE OR DELETE ON ai_draft FOR EACH ROW EXECUTE FUNCTION ai_draft_guard();

-- Safety filter result for one buyer message. Only messages with a flag get a row. The message itself is never changed.
CREATE TABLE message_safety_flag (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enquiry_id UUID NOT NULL REFERENCES enquiry(id),
  message_id UUID NOT NULL UNIQUE REFERENCES enquiry_message(id),
  risk TEXT NOT NULL CHECK (risk IN ('low','medium','high')),
  categories TEXT[] NOT NULL CHECK (cardinality(categories) >= 1),
  flags JSONB NOT NULL,
  handoff BOOLEAN NOT NULL,
  staff_review BOOLEAN NOT NULL,
  rules_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by UUID REFERENCES app_user(id),
  reviewed_at TIMESTAMPTZ,
  review_outcome TEXT CHECK (review_outcome IN ('confirmed','dismissed')),
  review_note TEXT CHECK (review_note IS NULL OR char_length(review_note) BETWEEN 1 AND 500),
  CHECK ((reviewed_at IS NULL) = (review_outcome IS NULL) AND (reviewed_at IS NULL) = (reviewed_by IS NULL))
);
CREATE INDEX message_safety_flag_enquiry_idx ON message_safety_flag(enquiry_id, created_at);
CREATE INDEX message_safety_flag_queue_idx ON message_safety_flag(created_at) WHERE staff_review AND reviewed_at IS NULL;

-- Only the review columns may change, once. Flags are never deleted.
CREATE OR REPLACE FUNCTION message_safety_flag_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'message_safety_flag is a permanent record'; END IF;
  IF OLD.reviewed_at IS NOT NULL THEN RAISE EXCEPTION 'message_safety_flag already reviewed'; END IF;
  IF NEW.enquiry_id <> OLD.enquiry_id OR NEW.message_id <> OLD.message_id OR NEW.risk <> OLD.risk OR NEW.categories <> OLD.categories
     OR NEW.flags <> OLD.flags OR NEW.handoff <> OLD.handoff OR NEW.staff_review <> OLD.staff_review OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'message_safety_flag result cannot change';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER message_safety_flag_guard_trg BEFORE UPDATE OR DELETE ON message_safety_flag FOR EACH ROW EXECUTE FUNCTION message_safety_flag_guard();

-- AI is paused on a thread once any message on it triggered a handoff, until the owner releases it.
CREATE TABLE enquiry_ai_pause (
  enquiry_id UUID PRIMARY KEY REFERENCES enquiry(id),
  paused BOOLEAN NOT NULL,
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 300),
  changed_by UUID REFERENCES app_user(id),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
