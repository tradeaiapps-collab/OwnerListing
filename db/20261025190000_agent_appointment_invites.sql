-- Owner invites an agent to manage a listing; the agent accepts before any access is granted (House Listing Spec, Flow B).
-- Accepting inserts the listing_agent_appointment row (db/004). Revoking sets revoked_at and revoked_by. Nothing is deleted.
CREATE TABLE agent_appointment_invite (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  agent_user_id UUID NOT NULL REFERENCES app_user(id),
  invited_by UUID NOT NULL REFERENCES app_user(id),
  scope TEXT NOT NULL CHECK (scope IN ('enquiries_and_offers','full')),
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','accepted','declined','withdrawn')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ,
  appointment_id UUID REFERENCES listing_agent_appointment(id),
  CHECK (agent_user_id <> invited_by),
  CHECK ((status = 'accepted') = (appointment_id IS NOT NULL))
);
-- One open invitation per agent per listing.
CREATE UNIQUE INDEX one_open_agent_invite ON agent_appointment_invite(listing_id, agent_user_id) WHERE status = 'proposed';
CREATE INDEX agent_appointment_invite_agent_idx ON agent_appointment_invite(agent_user_id, status);

ALTER TABLE listing_agent_appointment ADD COLUMN revoked_by UUID REFERENCES app_user(id);
CREATE INDEX listing_agent_appointment_agent_idx ON listing_agent_appointment(agent_user_id) WHERE revoked_at IS NULL;

-- Appointments and invitations are a permanent record of who could act on a listing.
CREATE OR REPLACE FUNCTION reject_agent_appointment_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are a permanent record', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_appointment_invite_no_delete BEFORE DELETE ON agent_appointment_invite
  FOR EACH ROW EXECUTE FUNCTION reject_agent_appointment_delete();
CREATE TRIGGER listing_agent_appointment_no_delete BEFORE DELETE ON listing_agent_appointment
  FOR EACH ROW EXECUTE FUNCTION reject_agent_appointment_delete();
