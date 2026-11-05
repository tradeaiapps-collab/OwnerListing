-- Sale fell through: one side says an accepted offer will not complete. The state rules propose what happens to the deposit held in
-- trust; the other side agrees or disputes. A dispute freezes the deposit until staff record an agreement or a court order. An agreed
-- outcome becomes the pre-filled refund / release requests in the existing two-person flow (deposit_release). Nothing is deleted.

ALTER TABLE formal_offer DROP CONSTRAINT formal_offer_status_check;
ALTER TABLE formal_offer ADD CONSTRAINT formal_offer_status_check
  CHECK (status IN ('submitted','under_review','countered','buyer_countered','accepted','rejected','withdrawn','expired','fallen_through'));

ALTER TABLE offer_event DROP CONSTRAINT offer_event_event_type_check;
ALTER TABLE offer_event ADD CONSTRAINT offer_event_event_type_check CHECK (event_type IN (
  'submitted','viewed','countered','owner_countered','buyer_countered','buyer_agreed','accepted','rejected','withdrawn','expired','superseded','handoff','fallen_through'));

CREATE TABLE sale_fall_through (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id UUID NOT NULL REFERENCES formal_offer(id),
  holding_id UUID NOT NULL REFERENCES deposit_holding(id),
  state TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('cooling_off','finance_condition','building_pest_condition','other_condition','buyer_default','seller_default','mutual_termination')),
  raised_by_party TEXT NOT NULL CHECK (raised_by_party IN ('buyer','owner')),
  raised_by UUID NOT NULL REFERENCES app_user(id),
  raised_on DATE NOT NULL,
  note TEXT CHECK (note IS NULL OR length(note) <= 1000),
  -- The proposed (and later agreed) outcome, in whole cents. Worked out from the deposit held when the case was raised.
  held_cents BIGINT NOT NULL CHECK (held_cents >= 0),
  refund_cents BIGINT NOT NULL CHECK (refund_cents >= 0),
  release_cents BIGINT NOT NULL CHECK (release_cents >= 0),
  penalty_cents BIGINT NOT NULL DEFAULT 0 CHECK (penalty_cents >= 0),
  penalty_unconfirmed BOOLEAN NOT NULL DEFAULT false,
  basis TEXT NOT NULL,
  rules_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','disputed','agreed','resolved','withdrawn')),
  responded_by UUID REFERENCES app_user(id),
  responded_at TIMESTAMPTZ,
  dispute_reason TEXT CHECK (dispute_reason IS NULL OR length(dispute_reason) <= 1000),
  -- How the outcome became final: both sides agreed, or staff recorded an agreement or court order after a dispute.
  resolution_source TEXT CHECK (resolution_source IN ('parties','agreement','court_order','sale_continues')),
  resolution_reference TEXT CHECK (resolution_reference IS NULL OR length(resolution_reference) <= 200),
  resolved_by UUID REFERENCES app_user(id),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (refund_cents + release_cents <= held_cents),
  CHECK (responded_by IS NULL OR responded_by <> raised_by)
);
-- One live case per offer. proposed, disputed and agreed all freeze the deposit.
CREATE UNIQUE INDEX sale_fall_through_one_live ON sale_fall_through(offer_id) WHERE status IN ('proposed','disputed','agreed');
CREATE INDEX sale_fall_through_holding_idx ON sale_fall_through(holding_id);

CREATE OR REPLACE FUNCTION reject_fall_through_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'sale_fall_through rows are a permanent record';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER sale_fall_through_no_delete BEFORE DELETE ON sale_fall_through FOR EACH ROW EXECUTE FUNCTION reject_fall_through_delete();

-- A payout request made from an agreed case is not a settlement release, so it does not need the settlement tick.
ALTER TABLE deposit_release ADD COLUMN fall_through_id UUID REFERENCES sale_fall_through(id);
DO $$
DECLARE c TEXT;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
    WHERE conrelid = 'deposit_release'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%settlement_confirmed%'
  LOOP
    EXECUTE format('ALTER TABLE deposit_release DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE deposit_release ADD CONSTRAINT deposit_release_settlement_check
  CHECK (kind = 'refund' OR settlement_confirmed OR fall_through_id IS NOT NULL);
-- Each agreed line (refund, release) is requested once unless the request was rejected.
CREATE UNIQUE INDEX deposit_release_one_per_case_line ON deposit_release(fall_through_id, kind) WHERE fall_through_id IS NOT NULL AND status <> 'rejected';
