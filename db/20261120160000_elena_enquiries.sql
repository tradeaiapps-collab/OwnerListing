-- Elena answers buyer enquiries and offers inspection times, per listing, only when the owner switches it on.
-- elena_enquiry_action is the owner-visible log: one row per buyer message Elena looked at (and one per booking or owner summary).

-- Elena's replies are automated messages in the thread. They must not share the one-notice-per-hour limit of the offer-link prompt.
ALTER TABLE enquiry_message ADD COLUMN elena BOOLEAN NOT NULL DEFAULT false;
DROP INDEX enquiry_message_one_notice_per_hour_idx;
CREATE UNIQUE INDEX enquiry_message_one_notice_per_hour_idx
  ON enquiry_message (enquiry_id, date_trunc('hour', sent_at AT TIME ZONE 'UTC'))
  WHERE automated AND NOT elena;

CREATE TABLE elena_enquiry_settings (
  listing_id UUID PRIMARY KEY REFERENCES property_listing(id),
  enabled BOOLEAN NOT NULL DEFAULT false,
  -- Elena may offer and book inspection times from the owner's open-inspection availability.
  offer_inspections BOOLEAN NOT NULL DEFAULT true,
  -- Off (the default): the owner approves every reply before the buyer sees it.
  auto_send BOOLEAN NOT NULL DEFAULT false,
  updated_by UUID NOT NULL REFERENCES app_user(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE elena_enquiry_action (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enquiry_id UUID NOT NULL REFERENCES enquiry(id),
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  owner_user_id UUID NOT NULL REFERENCES app_user(id),
  buyer_user_id UUID NOT NULL REFERENCES app_user(id),
  -- One action per buyer message, so a repeat run never answers twice. NULL for bookings and summaries.
  trigger_message_id UUID UNIQUE REFERENCES enquiry_message(id),
  kind TEXT NOT NULL CHECK (kind IN ('reply','booking','summary')),
  topics TEXT[] NOT NULL DEFAULT '{}',
  body TEXT CHECK (body IS NULL OR char_length(body) BETWEEN 1 AND 4000),
  status TEXT NOT NULL CHECK (status IN ('pending_approval','sent','discarded','blocked','rate_limited','handed_to_owner','failed')),
  reason TEXT,
  -- True while part of the question still needs the owner personally.
  needs_owner BOOLEAN NOT NULL DEFAULT false,
  sent_message_id UUID REFERENCES enquiry_message(id),
  booking_id UUID REFERENCES open_inspection_booking(id),
  decided_by UUID REFERENCES app_user(id),
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX elena_enquiry_action_owner_idx ON elena_enquiry_action (owner_user_id, created_at DESC);
CREATE INDEX elena_enquiry_action_enquiry_idx ON elena_enquiry_action (enquiry_id, created_at);
CREATE INDEX elena_enquiry_action_pending_idx ON elena_enquiry_action (owner_user_id) WHERE status = 'pending_approval' OR needs_owner;

-- Optional daily "what needs you" email. One row per owner; last_sent_on stops a second send on the same local day.
CREATE TABLE owner_digest_setting (
  user_id UUID PRIMARY KEY REFERENCES app_user(id),
  enabled BOOLEAN NOT NULL DEFAULT false,
  last_sent_on DATE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
