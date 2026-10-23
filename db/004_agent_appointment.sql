-- Owner appoints a licensed agent to act on one listing. The owner always keeps offer approval.
CREATE TABLE listing_agent_appointment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  agent_user_id UUID NOT NULL REFERENCES app_user(id),
  appointed_by UUID NOT NULL REFERENCES app_user(id),
  scope TEXT NOT NULL DEFAULT 'enquiries_and_offers' CHECK (scope IN ('enquiries_and_offers','full')),
  appointed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);
-- One active appointment per listing.
CREATE UNIQUE INDEX one_active_appointment_per_listing
  ON listing_agent_appointment(listing_id) WHERE revoked_at IS NULL;
