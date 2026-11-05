-- Security hardening for sale-fell-through (review of PR #220).
-- 1. A dispute resolution is proposed by one staff member and decided by a different one with approval rights.
ALTER TABLE sale_fall_through
  ADD COLUMN resolution_proposal JSONB,
  ADD COLUMN resolution_proposed_by UUID REFERENCES app_user(id),
  ADD COLUMN resolution_proposed_at TIMESTAMPTZ;

-- 2. The two-person rule on payouts is also held by the database, not only by the app (new rows; older rows are not re-checked).
ALTER TABLE deposit_release
  ADD CONSTRAINT deposit_release_two_person CHECK (decided_by IS NULL OR decided_by <> requested_by) NOT VALID;
