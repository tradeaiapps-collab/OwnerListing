-- Open inspection scheduling: the owner or appointed agent publishes times a buyer may walk through a listing; buyers book a slot.
-- Separate from the building-inspection marketplace (inspection, inspection_booking): these are viewings of the property for sale.
-- Times are stored in UTC; weekly rules and one-off dates are wall-clock times in the listing state's time zone.
CREATE TABLE open_inspection_availability (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  created_by UUID NOT NULL REFERENCES app_user(id),
  recurrence TEXT NOT NULL CHECK (recurrence IN ('once','weekly')),
  day_of_week SMALLINT CHECK (day_of_week BETWEEN 0 AND 6),
  on_date DATE,
  start_min SMALLINT NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
  end_min SMALLINT NOT NULL CHECK (end_min BETWEEN 1 AND 1440),
  slot_minutes SMALLINT NOT NULL CHECK (slot_minutes IN (15, 20, 30, 45, 60)),
  capacity SMALLINT NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 10),
  end_date DATE,
  removed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_min > start_min),
  CHECK ((recurrence = 'weekly' AND day_of_week IS NOT NULL AND on_date IS NULL) OR (recurrence = 'once' AND on_date IS NOT NULL AND day_of_week IS NULL))
);
CREATE INDEX open_inspection_availability_listing_idx ON open_inspection_availability(listing_id) WHERE removed_at IS NULL;

-- Times the agent has taken off the calendar (private viewings, a clash). Applies on top of every rule.
CREATE TABLE open_inspection_block (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  created_by UUID NOT NULL REFERENCES app_user(id),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  note TEXT NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  removed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX open_inspection_block_listing_idx ON open_inspection_block(listing_id, starts_at) WHERE removed_at IS NULL;

CREATE TABLE open_inspection_booking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  availability_id UUID REFERENCES open_inspection_availability(id),
  buyer_id UUID NOT NULL REFERENCES app_user(id),
  buyer_name TEXT NOT NULL CHECK (char_length(buyer_name) BETWEEN 1 AND 120),
  buyer_phone TEXT NOT NULL DEFAULT '' CHECK (char_length(buyer_phone) <= 30),
  buyer_email TEXT NOT NULL DEFAULT '' CHECK (char_length(buyer_email) <= 200),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  notes TEXT NOT NULL DEFAULT '' CHECK (char_length(notes) <= 500),
  status TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','rescheduled','cancelled','completed','no_show')),
  cancelled_by UUID REFERENCES app_user(id),
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX open_inspection_booking_listing_idx ON open_inspection_booking(listing_id, starts_at);
CREATE INDEX open_inspection_booking_buyer_idx ON open_inspection_booking(buyer_id, starts_at);
-- A buyer holds a slot once.
CREATE UNIQUE INDEX open_inspection_booking_live_idx ON open_inspection_booking(listing_id, buyer_id, starts_at) WHERE status = 'booked';

-- One row per reminder claimed for sending, so a repeat run never reminds twice.
CREATE TABLE open_inspection_reminder (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES open_inspection_booking(id),
  reminder_type TEXT NOT NULL CHECK (reminder_type IN ('24hr','1hr','custom')),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The automatic reminders go once each; an agent may send a custom one again.
CREATE UNIQUE INDEX open_inspection_reminder_once_idx ON open_inspection_reminder(booking_id, reminder_type) WHERE reminder_type <> 'custom';

CREATE OR REPLACE FUNCTION reject_open_inspection_booking_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'open_inspection_booking is a permanent record';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER open_inspection_booking_no_delete BEFORE DELETE ON open_inspection_booking
  FOR EACH ROW EXECUTE FUNCTION reject_open_inspection_booking_delete();
