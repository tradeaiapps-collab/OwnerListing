-- Offer history (House Listing Spec 019_negotiation, first slice). Insert-only: formal_offer.status is the current
-- projection, offer_event is the record of how it got there. Written in the same statement as the change it records.
CREATE TABLE offer_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id UUID NOT NULL REFERENCES formal_offer(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('submitted','viewed','countered','buyer_countered','accepted','rejected','withdrawn','expired','superseded','handoff')),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('buyer','owner','agent','ai','system')),
  actor_user_id UUID REFERENCES app_user(id),
  price_cents BIGINT,
  settlement_days SMALLINT,
  mfa_verified BOOLEAN NOT NULL DEFAULT false,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Only the owner accepts (the AI and agents never do). MFA is not built yet, so mfa_verified is not required here yet.
  CHECK (event_type <> 'accepted' OR actor_kind = 'owner')
);
CREATE INDEX offer_event_offer_idx ON offer_event(offer_id, occurred_at);

CREATE OR REPLACE FUNCTION reject_offer_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'offer_event is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER offer_event_append_only BEFORE UPDATE OR DELETE ON offer_event
  FOR EACH ROW EXECUTE FUNCTION reject_offer_event_mutation();

-- Offers made before this table existed get their submission event, so every offer has a timeline start.
INSERT INTO offer_event (offer_id, event_type, actor_kind, actor_user_id, price_cents, settlement_days, occurred_at)
SELECT id, 'submitted', 'buyer', buyer_user_id, price_cents, settlement_days, submitted_at FROM formal_offer;
