-- Security review 2026-10 (medium): the signing audit trail also records the owner reading a document ('owner_viewed') and every
-- refused signing attempt ('sign_failed'). The reason for a read or refusal is kept in detail.viewReason / detail.reason.
-- Rollback: delete the two new event types' rows is impossible (the table is append-only); to revert, restore the old CHECK only
-- while no such rows exist.
ALTER TABLE signing_event DROP CONSTRAINT IF EXISTS signing_event_event_type_check;
ALTER TABLE signing_event ADD CONSTRAINT signing_event_event_type_check
  CHECK (event_type IN ('created','sent','viewed','explained','signed','declined','completed','cancelled','voided','retried','stored','owner_viewed','sign_failed'));
