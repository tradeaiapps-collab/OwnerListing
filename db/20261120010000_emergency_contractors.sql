-- Emergency contractors: tradies who opt in to urgent call-outs, and the urgent requests owners and tenants send them.
-- The contractor chooses to be listed, the hours they accept (in their own time zone) and the contact details shown. Payment is always direct to the contractor.
CREATE TABLE emergency_contractor (
  user_id UUID NOT NULL REFERENCES app_user(id),
  trade TEXT NOT NULL CHECK (trade IN ('plumber','electrician','locksmith','glazier','roofer','gas_fitter','air_conditioning','pest_control','builder','tree_removal')),
  enabled BOOLEAN NOT NULL DEFAULT false,
  time_zone TEXT NOT NULL CHECK (char_length(time_zone) BETWEEN 3 AND 64),
  all_hours BOOLEAN NOT NULL DEFAULT false,
  -- [{ "days": [0..6] (0 = Sunday), "start": "HH:MM", "end": "HH:MM" }]; an end at or before the start runs past midnight.
  windows JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(windows) = 'array' AND jsonb_array_length(windows) <= 14),
  call_out_cents INTEGER CHECK (call_out_cents IS NULL OR call_out_cents BETWEEN 0 AND 1000000),
  business_name TEXT CHECK (business_name IS NULL OR char_length(business_name) BETWEEN 1 AND 80),
  contact_phone TEXT NOT NULL CHECK (char_length(contact_phone) BETWEEN 6 AND 20),
  contact_email TEXT CHECK (contact_email IS NULL OR char_length(contact_email) <= 254),
  note TEXT CHECK (note IS NULL OR char_length(note) <= 300),
  service_suburbs TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(service_suburbs) <= 200),
  service_postcodes TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(service_postcodes) <= 200),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, trade)
);
CREATE INDEX emergency_contractor_trade_idx ON emergency_contractor (trade) WHERE enabled;

CREATE SEQUENCE emergency_request_number_seq START 5001;

CREATE TABLE emergency_request (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Shown as EMG-5001. When a contractor accepts, the request is the numbered job.
  number BIGINT NOT NULL UNIQUE DEFAULT nextval('emergency_request_number_seq'),
  requester_user_id UUID NOT NULL REFERENCES app_user(id),
  listing_id UUID REFERENCES property_listing(id),
  property_kind TEXT NOT NULL CHECK (property_kind IN ('sale','rental','other')),
  trade TEXT NOT NULL CHECK (trade IN ('plumber','electrician','locksmith','glazier','roofer','gas_fitter','air_conditioning','pest_control','builder','tree_removal')),
  description TEXT NOT NULL CHECK (char_length(description) BETWEEN 10 AND 1000),
  address_text TEXT NOT NULL CHECK (char_length(address_text) BETWEEN 3 AND 200),
  suburb TEXT CHECK (suburb IS NULL OR char_length(suburb) BETWEEN 1 AND 80),
  postcode CHAR(4) CHECK (postcode IS NULL OR postcode ~ '^[0-9]{4}$'),
  -- Shared only with the contractor who accepts.
  callback_phone TEXT CHECK (callback_phone IS NULL OR char_length(callback_phone) BETWEEN 6 AND 20),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','cancelled')),
  accepted_contractor_user_id UUID REFERENCES app_user(id),
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status = 'accepted') = (accepted_contractor_user_id IS NOT NULL))
);
CREATE INDEX emergency_request_requester_idx ON emergency_request (requester_user_id, created_at DESC);

CREATE TABLE emergency_request_contact (
  request_id UUID NOT NULL REFERENCES emergency_request(id),
  contractor_user_id UUID NOT NULL REFERENCES app_user(id),
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','failed','accepted','declined','closed')),
  email_status TEXT NOT NULL DEFAULT 'skipped' CHECK (email_status IN ('sent','failed','skipped')),
  sms_status TEXT NOT NULL DEFAULT 'skipped' CHECK (sms_status IN ('sent','failed','skipped')),
  note TEXT CHECK (note IS NULL OR char_length(note) <= 300),
  eta_minutes INTEGER CHECK (eta_minutes IS NULL OR eta_minutes BETWEEN 1 AND 1440),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  replied_at TIMESTAMPTZ,
  PRIMARY KEY (request_id, contractor_user_id)
);
CREATE INDEX emergency_request_contact_contractor_idx ON emergency_request_contact (contractor_user_id, sent_at DESC);
