-- Sold and rented events. property_event (db/008) already holds them and feeds market intelligence; this adds who, which offer,
-- how it got there (accepted offer or staff entry) and a void switch. Rows are never deleted: a wrong or fallen-through event is voided
-- with a reason, and a voided event drops out of valuations and comparable sales.
ALTER TABLE property_event
  ADD COLUMN offer_id UUID REFERENCES formal_offer(id),
  ADD COLUMN agent_user_id UUID REFERENCES app_user(id),
  ADD COLUMN buyer_user_id UUID REFERENCES app_user(id),
  ADD COLUMN counterparty_label TEXT CHECK (counterparty_label IS NULL OR char_length(counterparty_label) <= 120),
  ADD COLUMN origin TEXT CHECK (origin IN ('accepted_offer','staff_manual')),
  ADD COLUMN recorded_by TEXT,
  ADD COLUMN note TEXT CHECK (note IS NULL OR char_length(note) <= 1000),
  ADD COLUMN voided_at TIMESTAMPTZ,
  ADD COLUMN voided_by TEXT,
  ADD COLUMN void_reason TEXT,
  ADD CONSTRAINT property_event_offer_origin CHECK (origin IS DISTINCT FROM 'accepted_offer' OR offer_id IS NOT NULL),
  ADD CONSTRAINT property_event_void_complete CHECK ((voided_at IS NULL) = (voided_by IS NULL AND void_reason IS NULL));

-- One event per accepted offer, even after it is voided, so a sweep never brings back a sale that fell through.
CREATE UNIQUE INDEX property_event_offer_uidx ON property_event(offer_id) WHERE offer_id IS NOT NULL;
CREATE INDEX property_event_sale_idx ON property_event(occurred_at DESC, id) WHERE event_type IN ('sold','rented');

-- Sold and rented events cannot be deleted, and apart from voiding they cannot be edited.
CREATE FUNCTION property_event_sale_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.event_type NOT IN ('sold','rented') THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'sold and rented events cannot be deleted; void them instead'; END IF;
  IF OLD.voided_at IS NOT NULL THEN RAISE EXCEPTION 'a voided event cannot be changed'; END IF;
  IF (NEW.id, NEW.property_id, NEW.listing_id, NEW.event_type, NEW.occurred_at, NEW.amount_cents, NEW.source, NEW.offer_id, NEW.agent_user_id, NEW.buyer_user_id, NEW.origin)
     IS DISTINCT FROM (OLD.id, OLD.property_id, OLD.listing_id, OLD.event_type, OLD.occurred_at, OLD.amount_cents, OLD.source, OLD.offer_id, OLD.agent_user_id, OLD.buyer_user_id, OLD.origin) THEN
    RAISE EXCEPTION 'a sold or rented event can only be voided, not edited';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER property_event_sale_guard BEFORE UPDATE OR DELETE ON property_event FOR EACH ROW EXECUTE FUNCTION property_event_sale_guard();
