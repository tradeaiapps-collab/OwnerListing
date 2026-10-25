-- Counter-offers on the offer history (main's offer_event, 20261025200000). Adds the two negotiation events and the
-- columns a counter carries, so every counter, agreement, withdrawal and lapse is recorded with its terms.
--   countered        the owner asked the buyer for a better offer (no terms), as already written by decisions
--   owner_countered  the owner sent a counter-offer with their own terms
--   buyer_agreed     the buyer agreed to the owner's open counter; the owner still decides
ALTER TABLE offer_event DROP CONSTRAINT offer_event_event_type_check;
ALTER TABLE offer_event ADD CONSTRAINT offer_event_event_type_check CHECK (event_type IN (
  'submitted','viewed','countered','owner_countered','buyer_countered','buyer_agreed','accepted','rejected','withdrawn','expired','superseded','handoff'));

ALTER TABLE offer_event
  ADD COLUMN counter_id UUID REFERENCES offer_counter(id),
  ADD COLUMN counter_round SMALLINT,
  ADD COLUMN conditions JSONB,
  ADD COLUMN deposit_cents BIGINT,
  ADD COLUMN from_status TEXT,
  -- NULL on rows written before this migration.
  ADD COLUMN to_status TEXT;

-- A lapse is the system's doing, never a person's.
ALTER TABLE offer_event ADD CONSTRAINT offer_event_expired_by_system CHECK (event_type <> 'expired' OR actor_kind = 'system');

CREATE INDEX offer_event_counter_idx ON offer_event(counter_id) WHERE counter_id IS NOT NULL;

-- Owner decisions made before offer_event existed are only in the audit log. Copy those across once; decisions already
-- in offer_event (written since 20261025200000) are skipped.
INSERT INTO offer_event (offer_id, event_type, actor_kind, actor_user_id, from_status, to_status, occurred_at)
SELECT o.id, substring(a.event_type FROM 7), 'owner', u.id, a.payload->>'from', substring(a.event_type FROM 7), a.occurred_at
FROM audit_event a
JOIN formal_offer o ON o.id::text = a.aggregate_id
JOIN app_user u ON u.id::text = a.actor_id
WHERE a.aggregate_type = 'formal_offer'
  AND a.event_type IN ('offer.accepted', 'offer.rejected', 'offer.countered')
  AND NOT EXISTS (SELECT 1 FROM offer_event e WHERE e.offer_id = o.id AND e.event_type = substring(a.event_type FROM 7));
