CREATE TABLE job_assignment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  owner_user_id UUID NOT NULL REFERENCES app_user(id),
  contractor_user_id UUID NOT NULL REFERENCES app_user(id),
  kind TEXT NOT NULL CHECK (kind IN ('photographer','solicitor','inspector','agent','other')),
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','completed','cancelled')),
  approved_at TIMESTAMPTZ
);

CREATE TABLE chat_message (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id UUID NOT NULL REFERENCES job_assignment(id),
  sender_id UUID NOT NULL REFERENCES app_user(id),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  attachment_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX chat_message_assignment_idx ON chat_message(assignment_id, sent_at);

-- Permanent record: no edits or deletes by any application role.
CREATE OR REPLACE FUNCTION reject_chat_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'chat_message is a permanent record';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER chat_message_no_update_delete
  BEFORE UPDATE OR DELETE ON chat_message
  FOR EACH ROW EXECUTE FUNCTION reject_chat_mutation();
