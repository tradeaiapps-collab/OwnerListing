-- Inspection marketplace: a verified buyer asks for an inspection of a published listing, an approved inspector accepts it,
-- and the accepted booking becomes an `inspection` row (see 20261105100000_inspections.sql) where findings, photos, shares and Elena's summary live.
-- Nothing here is deleted by the application.

CREATE TABLE inspector_profile (
  user_id UUID PRIMARY KEY REFERENCES app_user(id),
  business_name TEXT NOT NULL CHECK (length(business_name) BETWEEN 1 AND 120),
  licence_ref TEXT NOT NULL DEFAULT '' CHECK (length(licence_ref) <= 80),
  jurisdictions TEXT[] NOT NULL CHECK (cardinality(jurisdictions) BETWEEN 1 AND 8
    AND jurisdictions <@ ARRAY['NSW','VIC','QLD','WA','SA','TAS','ACT','NT']::text[]),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','suspended')),
  reviewed_by UUID REFERENCES app_user(id),
  reviewed_at TIMESTAMPTZ,
  review_note TEXT NOT NULL DEFAULT '' CHECK (length(review_note) <= 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX inspector_profile_status_idx ON inspector_profile(status, created_at);

CREATE TABLE inspection_booking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  buyer_id UUID NOT NULL REFERENCES app_user(id),
  -- One to three ISO start times the buyer can do; the inspector picks one.
  slots JSONB NOT NULL CHECK (jsonb_typeof(slots) = 'array' AND jsonb_array_length(slots) BETWEEN 1 AND 3),
  notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 1000),
  status TEXT NOT NULL DEFAULT 'pending_inspector_response' CHECK (status IN ('pending_inspector_response','scheduled','cancelled')),
  inspection_id UUID REFERENCES inspection(id),
  inspector_user_id UUID REFERENCES app_user(id),
  scheduled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at TIMESTAMPTZ,
  CONSTRAINT inspection_booking_shape CHECK (
    (status <> 'scheduled' OR (inspection_id IS NOT NULL AND inspector_user_id IS NOT NULL AND scheduled_at IS NOT NULL))
    AND (status <> 'pending_inspector_response' OR (inspection_id IS NULL AND inspector_user_id IS NULL)))
);
CREATE INDEX inspection_booking_buyer_idx ON inspection_booking(buyer_id, created_at DESC);
CREATE INDEX inspection_booking_pending_idx ON inspection_booking(created_at) WHERE status = 'pending_inspector_response';
-- A buyer has at most one open request per listing.
CREATE UNIQUE INDEX inspection_booking_open_idx ON inspection_booking(listing_id, buyer_id) WHERE status <> 'cancelled';

-- An inspector who passes on a request only hides it from their own list.
CREATE TABLE inspection_booking_pass (
  booking_id UUID NOT NULL REFERENCES inspection_booking(id),
  inspector_user_id UUID NOT NULL REFERENCES app_user(id),
  passed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (booking_id, inspector_user_id)
);

CREATE TRIGGER inspection_booking_no_delete BEFORE DELETE ON inspection_booking FOR EACH ROW EXECUTE FUNCTION inspection_no_delete();
CREATE TRIGGER inspector_profile_no_delete BEFORE DELETE ON inspector_profile FOR EACH ROW EXECUTE FUNCTION inspection_no_delete();
