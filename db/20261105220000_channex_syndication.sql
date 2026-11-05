-- Listing syndication through the Channex channel manager (one certified connection to Airbnb, Booking.com and Vrbo).
--   syndication_portal.mode gains 'channex': the portal is reached through Channex with the account-wide CHANNEX_* keys.
--   channex_property: the Channex property, room type and rate plan made for one listing (shared by every portal in channex mode),
--     hashes of what was last sent so unchanged content and calendars are not sent again, and which portals the owner has connected.
ALTER TABLE syndication_portal DROP CONSTRAINT IF EXISTS syndication_portal_mode_check;
ALTER TABLE syndication_portal ADD CONSTRAINT syndication_portal_mode_check CHECK (mode IN ('api', 'manual', 'channex'));

CREATE TABLE channex_property (
  listing_id UUID PRIMARY KEY REFERENCES property_listing(id),
  property_id TEXT UNIQUE CHECK (property_id IS NULL OR char_length(property_id) <= 64),
  room_type_id TEXT CHECK (room_type_id IS NULL OR char_length(room_type_id) <= 64),
  rate_plan_id TEXT CHECK (rate_plan_id IS NULL OR char_length(rate_plan_id) <= 64),
  content_hash CHAR(64),
  ari_hash CHAR(64),
  ari_closed BOOLEAN NOT NULL DEFAULT false,
  connected_portals TEXT[] NOT NULL DEFAULT ARRAY[]::text[] CHECK (connected_portals <@ ARRAY['airbnb', 'vrbo', 'booking_com']::text[]),
  synced_at TIMESTAMPTZ,
  lease_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
