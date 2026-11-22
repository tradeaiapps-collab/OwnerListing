-- Calendar import: pull booked dates back from Airbnb, VRBO and Booking.com through the iCal link each portal gives the host.
--   syndication_calendar_import  one link per listing and portal (the link is a secret on these portals, so it is stored sealed)
--   syndication_booking.source   'webhook' (portal partner API) or 'ical' (imported blocked dates)
ALTER TABLE syndication_booking ADD COLUMN source TEXT NOT NULL DEFAULT 'webhook' CHECK (source IN ('webhook', 'ical'));

CREATE TABLE syndication_calendar_import (
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  portal TEXT NOT NULL REFERENCES syndication_portal(portal),
  url_enc TEXT NOT NULL,
  last_status TEXT CHECK (last_status IN ('ok', 'failed')),
  last_error TEXT CHECK (last_error IS NULL OR char_length(last_error) <= 300),
  last_synced_at TIMESTAMPTZ,
  last_event_count INT,
  attempts INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_until TIMESTAMPTZ,
  updated_by UUID REFERENCES app_user(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (listing_id, portal)
);
CREATE INDEX syndication_calendar_import_due_idx ON syndication_calendar_import (next_attempt_at);
