-- Staff reset of a user's second sign-in step, for a lost or replaced phone. Super admin only (enforced in the app).
-- A reset revokes every live method, retires the recovery codes and ends every session that passed MFA before it. The user signs in
-- again with Google (their verified email) and is sent to set up a new method before anything else works.

-- One row per reset. Insert only: never updated or deleted. Whether the notice email went out is in the audit event.
CREATE TABLE mfa_reset_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES app_user(id),
  reset_by        UUID        NOT NULL REFERENCES app_user(id),
  reason          TEXT        NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 300),
  methods_revoked INTEGER     NOT NULL CHECK (methods_revoked >= 0),
  reset_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (reset_by <> user_id)
);
CREATE INDEX mfa_reset_log_user_idx ON mfa_reset_log(user_id, reset_at DESC);
CREATE TRIGGER mfa_reset_log_append_only
  BEFORE UPDATE OR DELETE ON mfa_reset_log
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

ALTER TABLE mfa_event_log DROP CONSTRAINT mfa_event_log_event_check;
ALTER TABLE mfa_event_log ADD CONSTRAINT mfa_event_log_event_check CHECK (event IN ('setup_started','enrolled','verified','code_wrong','code_expired','code_locked',
  'code_sent','send_failed','recovery_used','recovery_regenerated','factor_removed','rate_limited','staff_reset'));
