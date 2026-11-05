-- Client portal: viewing and consultation requests. A buyer asks for a time on a published listing; the owner (or full-scope agent) confirms or declines.
-- Permanent record: rows are never deleted (a trigger refuses it); cancelling or declining only changes status. Each change also writes an audit_event row.
CREATE TABLE viewing_booking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  requester_user_id UUID NOT NULL REFERENCES app_user(id),
  kind TEXT NOT NULL CHECK (kind IN ('viewing','consultation')),
  starts_at TIMESTAMPTZ NOT NULL,
  note TEXT NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','confirmed','declined','cancelled')),
  decided_by UUID REFERENCES app_user(id),
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX viewing_booking_requester_idx ON viewing_booking(requester_user_id, starts_at);
CREATE INDEX viewing_booking_listing_idx ON viewing_booking(listing_id, starts_at);
-- One live request per person, listing, kind and time.
CREATE UNIQUE INDEX viewing_booking_live_idx ON viewing_booking(listing_id, requester_user_id, kind, starts_at) WHERE status IN ('requested','confirmed');

CREATE OR REPLACE FUNCTION reject_viewing_booking_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'viewing_booking is a permanent record';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER viewing_booking_no_delete BEFORE DELETE ON viewing_booking
  FOR EACH ROW EXECUTE FUNCTION reject_viewing_booking_delete();
