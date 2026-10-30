-- The assistant (Elena by default) as a participant in buyer-owner enquiry threads. Each row is one question from a party
-- and her answer. Both parties see every row. Permanent record, like enquiry_message: no updates or deletes.
-- The answer is built from the listing and the formal offer only (never the negotiation mandate or floor).
--
-- Rollback (manual): DROP TABLE enquiry_assistant_turn; delete this file's row from schema_migration.

CREATE TABLE enquiry_assistant_turn (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enquiry_id       UUID        NOT NULL REFERENCES enquiry(id),
  asked_by_user_id UUID        NOT NULL REFERENCES app_user(id),
  asked_by_role    TEXT        NOT NULL CHECK (asked_by_role IN ('buyer','owner','agent')),
  question         TEXT        NOT NULL CHECK (char_length(question) BETWEEN 1 AND 500),
  topic            TEXT        NOT NULL CHECK (topic IN ('welcome','offer','compromise','settlement','deposit','conditions','listing','next_steps','privacy','advice','unknown')),
  pose             TEXT        NOT NULL CHECK (pose IN ('wave','tablet','front','three-quarter')),
  answer           TEXT        NOT NULL CHECK (char_length(answer) BETWEEN 1 AND 4000),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX enquiry_assistant_turn_thread_idx ON enquiry_assistant_turn (enquiry_id, created_at);

CREATE TRIGGER enquiry_assistant_turn_append_only BEFORE UPDATE OR DELETE ON enquiry_assistant_turn
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
