-- Owner and appointed agent talk inside the platform, one conversation per appointment.
-- Permanent record: no edits or deletes by any application role (same rule as chat_message, db/007).
CREATE TABLE agent_message (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id UUID NOT NULL REFERENCES listing_agent_appointment(id),
  sender_user_id UUID NOT NULL REFERENCES app_user(id),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX agent_message_appointment_idx ON agent_message(appointment_id, sent_at);

CREATE OR REPLACE FUNCTION reject_agent_message_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'agent_message is a permanent record';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_message_no_update_delete
  BEFORE UPDATE OR DELETE ON agent_message
  FOR EACH ROW EXECUTE FUNCTION reject_agent_message_mutation();
