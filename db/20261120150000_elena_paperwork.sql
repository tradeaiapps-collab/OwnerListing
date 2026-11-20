-- Elena chases missing sale paperwork for owners who switch it on per listing.
-- Settings are per listing. elena_paperwork_chase tracks one reminder run per listing and person (owner or buyer).
-- elena_paperwork_message is the permanent, visible log of everything she sent. Nothing here accepts an offer or moves money.
CREATE TABLE elena_paperwork_settings (
  listing_id UUID PRIMARY KEY REFERENCES property_listing(id),
  chase BOOLEAN NOT NULL DEFAULT false,
  updated_by UUID NOT NULL REFERENCES app_user(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE elena_paperwork_chase (
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  party TEXT NOT NULL CHECK (party IN ('owner','buyer')),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','done','stopped')),
  reminders INT NOT NULL DEFAULT 0,
  next_action_at TIMESTAMPTZ NOT NULL,
  last_sent_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (listing_id, party)
);
CREATE INDEX elena_paperwork_chase_due_idx ON elena_paperwork_chase (next_action_at) WHERE state = 'active';

CREATE TABLE elena_paperwork_message (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  party TEXT NOT NULL CHECK (party IN ('owner','buyer')),
  kind TEXT NOT NULL CHECK (kind IN ('reminder','stopped')),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  status TEXT NOT NULL CHECK (status IN ('sent','blocked','rate_limited','failed')),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX elena_paperwork_message_listing_idx ON elena_paperwork_message (listing_id, created_at DESC);
CREATE INDEX elena_paperwork_message_rate_idx ON elena_paperwork_message (listing_id, party, created_at) WHERE status = 'sent';
CREATE TRIGGER elena_paperwork_message_append_only BEFORE UPDATE OR DELETE ON elena_paperwork_message FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
