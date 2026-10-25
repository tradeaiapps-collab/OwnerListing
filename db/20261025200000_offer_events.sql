-- Offer timeline: one row per state change of a formal offer, written in the same statement as the change.
-- Insert-only (trigger below); formal_offer.status is the current state, offer_event is the history.
CREATE TABLE offer_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id UUID NOT NULL REFERENCES formal_offer(id),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'submitted','counter_requested','countered','buyer_countered','buyer_agreed','accepted','rejected','withdrawn','expired')),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('buyer','owner','system')),
  actor_user_id UUID REFERENCES app_user(id),
  counter_id UUID REFERENCES offer_counter(id),
  counter_round SMALLINT,
  -- The terms this event put on the table (or accepted). NULL when the event carries no terms (rejected, withdrawn, a plain request).
  price_cents BIGINT, conditions JSONB, settlement_days INTEGER, deposit_cents BIGINT,
  from_status TEXT,
  to_status TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((actor_kind = 'system') = (actor_user_id IS NULL)),
  CHECK (event_type <> 'accepted' OR actor_kind = 'owner'),
  CHECK (event_type <> 'expired' OR actor_kind = 'system')
);
CREATE INDEX offer_event_offer_idx ON offer_event(offer_id, occurred_at, id);
CREATE TRIGGER offer_event_append_only BEFORE UPDATE OR DELETE ON offer_event
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

-- Backfill so offers made before this migration have a timeline: submissions from formal_offer, owner and buyer actions from
-- the audit log (actor ids there are text), lapsed counters from offer_counter.
INSERT INTO offer_event (offer_id, event_type, actor_kind, actor_user_id, price_cents, conditions, settlement_days, deposit_cents, to_status, occurred_at)
SELECT id, 'submitted', 'buyer', buyer_user_id, price_cents, conditions, settlement_days, deposit_cents, 'submitted', submitted_at FROM formal_offer;

INSERT INTO offer_event (offer_id, event_type, actor_kind, actor_user_id, counter_id, counter_round,
  price_cents, conditions, settlement_days, deposit_cents, from_status, to_status, occurred_at)
SELECT o.id,
  CASE a.event_type
    WHEN 'offer.countered' THEN CASE WHEN a.payload ? 'counterId' THEN 'countered' ELSE 'counter_requested' END
    ELSE substring(a.event_type FROM 7) END,
  CASE WHEN a.event_type IN ('offer.buyer_countered', 'offer.buyer_agreed', 'offer.withdrawn') THEN 'buyer' ELSE 'owner' END,
  u.id, c.id, c.round, c.price_cents, c.conditions, c.settlement_days, c.deposit_cents,
  a.payload->>'from',
  CASE a.event_type WHEN 'offer.buyer_agreed' THEN 'buyer_countered' ELSE substring(a.event_type FROM 7) END,
  a.occurred_at
FROM audit_event a
JOIN formal_offer o ON o.id::text = a.aggregate_id
JOIN app_user u ON u.id::text = a.actor_id
LEFT JOIN offer_counter c ON c.id::text = a.payload->>'counterId'
WHERE a.aggregate_type = 'formal_offer'
  AND a.event_type IN ('offer.accepted','offer.rejected','offer.countered','offer.buyer_countered','offer.buyer_agreed','offer.withdrawn');

INSERT INTO offer_event (offer_id, event_type, actor_kind, counter_id, counter_round, to_status, occurred_at)
SELECT offer_id, 'expired', 'system', id, round, 'expired', closed_at FROM offer_counter WHERE status = 'expired';
