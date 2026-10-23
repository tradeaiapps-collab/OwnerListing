CREATE TABLE buyer_verification (
  user_id UUID PRIMARY KEY REFERENCES app_user(id),
  email_verified_at TIMESTAMPTZ,
  phone_verified_at TIMESTAMPTZ,
  id_verified_at TIMESTAMPTZ,     -- ID document checked against government records and live selfie matched
  id_provider_ref TEXT            -- reference only; identity documents are held by the verification provider
);

CREATE TABLE saved_search (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_user_id UUID NOT NULL REFERENCES app_user(id),
  criteria JSONB NOT NULL,        -- property facts only: type, state, suburbs, price range, bedrooms
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX saved_search_active_idx ON saved_search(active) WHERE active;

-- Consent is recorded per channel. Unsubscribing never deletes the record.
CREATE TABLE alert_preference (
  buyer_user_id UUID NOT NULL REFERENCES app_user(id),
  channel TEXT NOT NULL CHECK (channel IN ('email','sms')),
  consent_given_at TIMESTAMPTZ,
  unsubscribed_at TIMESTAMPTZ,
  PRIMARY KEY (buyer_user_id, channel)
);
