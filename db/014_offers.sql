-- Offer links sent in chat. Only a hash of the token is stored. A link works once.
CREATE TABLE offer_link (
  token_hash CHAR(64) PRIMARY KEY,
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  buyer_user_id UUID NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);

-- Formal offers, submitted only through the form. Terms are not edited after submission:
-- a changed offer is a new submission with a new link.
CREATE TABLE formal_offer (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  buyer_user_id UUID NOT NULL REFERENCES app_user(id),
  price_cents BIGINT NOT NULL CHECK (price_cents > 0),
  conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
  settlement_days INTEGER NOT NULL CHECK (settlement_days BETWEEN 1 AND 365),
  deposit_cents BIGINT NOT NULL CHECK (deposit_cents >= 0 AND deposit_cents <= price_cents),
  confirmed_final BOOLEAN NOT NULL CHECK (confirmed_final),
  link_token_hash CHAR(64) NOT NULL UNIQUE REFERENCES offer_link(token_hash),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','under_review','countered','accepted','rejected','withdrawn')),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX formal_offer_listing_idx ON formal_offer(listing_id, submitted_at);

-- Prices mentioned in chat that triggered the automated prompt. They are not formal offers.
CREATE TABLE chat_offer_mention (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  buyer_user_id UUID NOT NULL REFERENCES app_user(id),
  chat_message_id UUID,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  prompt_sent_at TIMESTAMPTZ
);
