-- Elena's settlement coaching: which suggestions were shown on an accepted offer, whether the person used or dismissed each one,
-- and how the deal ended. One row per offer, suggestion and side. Nothing is deleted.

CREATE TABLE negotiation_coaching_offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id UUID NOT NULL REFERENCES formal_offer(id),
  settlement_id UUID NOT NULL REFERENCES settlement_timeline(id),
  suggestion_type TEXT NOT NULL CHECK (suggestion_type IN ('inspection_waived','inspection_window_short','settlement_too_short','settlement_long','finance_unverified','finance_timeline_tight','deposit_low','subject_to_sale','settlement_flex_trade','price_gap_compromise')),
  side TEXT NOT NULL CHECK (side IN ('buyer','seller','agent')),
  -- NULL until the person decides: true = used the suggestion, false = dismissed it.
  accepted BOOLEAN,
  decided_by UUID REFERENCES app_user(id),
  decided_at TIMESTAMPTZ,
  shown_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Filled in once the deal ends.
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('settled','fell_through')),
  outcome_at TIMESTAMPTZ,
  days_to_settle INTEGER CHECK (days_to_settle IS NULL OR days_to_settle >= 0),
  UNIQUE (offer_id, suggestion_type, side),
  CHECK ((accepted IS NULL) = (decided_at IS NULL))
);
CREATE INDEX negotiation_coaching_settlement_idx ON negotiation_coaching_offers(settlement_id);
CREATE INDEX negotiation_coaching_open_idx ON negotiation_coaching_offers(offer_id) WHERE outcome IS NULL;

CREATE OR REPLACE FUNCTION reject_coaching_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'coaching records are a permanent record';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER negotiation_coaching_no_delete BEFORE DELETE ON negotiation_coaching_offers FOR EACH ROW EXECUTE FUNCTION reject_coaching_delete();
