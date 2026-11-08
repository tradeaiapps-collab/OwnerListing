-- Listing syndication: publish rental listings to outside portals (Airbnb, VRBO, Booking.com) and take bookings back.
--   syndication_portal           staff setup per portal (secrets sealed, never returned)
--   syndication_listing_setting  per-listing opt-in and portal-specific fields
--   syndication_sync             where each listing stands on each portal (external id, content hash, retry state)
--   syndication_log              insert-only call log, also the per-portal rate-limit counter
--   syndication_booking          bookings received from portals; doubles as the listing's booked-dates calendar
--   syndication_feed             iCal feed token (hash only) so a portal can read booked dates
CREATE TABLE syndication_portal (
  portal TEXT PRIMARY KEY CHECK (portal IN ('airbnb', 'vrbo', 'booking_com')),
  enabled BOOLEAN NOT NULL DEFAULT false,
  mode TEXT NOT NULL DEFAULT 'manual' CHECK (mode IN ('api', 'manual')),
  base_url TEXT CHECK (base_url IS NULL OR (base_url LIKE 'https://%' AND char_length(base_url) <= 300)),
  api_key_enc TEXT,
  webhook_secret_enc TEXT,
  allowed_transaction_types TEXT[] NOT NULL DEFAULT ARRAY['rent']::text[]
    CHECK (allowed_transaction_types <@ ARRAY['rent', 'sale']::text[]),
  max_per_minute INT NOT NULL DEFAULT 30 CHECK (max_per_minute BETWEEN 1 AND 600),
  updated_by UUID REFERENCES app_user(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO syndication_portal (portal, mode) VALUES ('airbnb', 'manual'), ('vrbo', 'api'), ('booking_com', 'api');

CREATE TABLE syndication_listing_setting (
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  portal TEXT NOT NULL REFERENCES syndication_portal(portal),
  enabled BOOLEAN NOT NULL DEFAULT false,
  custom JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(custom) = 'object'),
  manual_url TEXT CHECK (manual_url IS NULL OR (manual_url LIKE 'https://%' AND char_length(manual_url) <= 500)),
  updated_by UUID NOT NULL REFERENCES app_user(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (listing_id, portal)
);

CREATE TABLE syndication_sync (
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  portal TEXT NOT NULL REFERENCES syndication_portal(portal),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'live', 'failed', 'removed', 'manual', 'manual_removal')),
  external_id TEXT CHECK (external_id IS NULL OR char_length(external_id) <= 200),
  external_url TEXT CHECK (external_url IS NULL OR (external_url LIKE 'https://%' AND char_length(external_url) <= 500)),
  content_hash CHAR(64),
  attempts INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  lease_until TIMESTAMPTZ,
  last_error TEXT CHECK (last_error IS NULL OR char_length(last_error) <= 300),
  last_synced_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (listing_id, portal)
);
CREATE UNIQUE INDEX syndication_sync_external_idx ON syndication_sync (portal, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX syndication_sync_due_idx ON syndication_sync (state, next_attempt_at);

CREATE TABLE syndication_log (
  id BIGSERIAL PRIMARY KEY,
  portal TEXT NOT NULL,
  listing_id UUID,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'remove')),
  ok BOOLEAN NOT NULL,
  http_status INT,
  error TEXT CHECK (error IS NULL OR char_length(error) <= 300),
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX syndication_log_portal_at_idx ON syndication_log (portal, at);

CREATE TABLE syndication_booking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  portal TEXT NOT NULL REFERENCES syndication_portal(portal),
  external_booking_id TEXT NOT NULL CHECK (char_length(external_booking_id) BETWEEN 1 AND 200),
  guest_name TEXT NOT NULL CHECK (char_length(guest_name) BETWEEN 1 AND 120),
  guests INT CHECK (guests IS NULL OR guests BETWEEN 1 AND 100),
  check_in DATE NOT NULL,
  check_out DATE NOT NULL,
  total_cents BIGINT CHECK (total_cents IS NULL OR total_cents >= 0),
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled', 'conflict')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at TIMESTAMPTZ,
  CHECK (check_out > check_in),
  UNIQUE (portal, external_booking_id)
);
CREATE INDEX syndication_booking_listing_idx ON syndication_booking (listing_id, check_in);

CREATE TABLE syndication_feed (
  listing_id UUID PRIMARY KEY REFERENCES property_listing(id),
  token_hash CHAR(64) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
