-- One reminder per open agent invitation: reminded_at is set when the reminder is claimed, so it is never sent twice.
ALTER TABLE agent_appointment_invite ADD COLUMN reminded_at TIMESTAMPTZ;
CREATE INDEX agent_invite_reminder_idx ON agent_appointment_invite(created_at) WHERE status = 'proposed' AND reminded_at IS NULL;
