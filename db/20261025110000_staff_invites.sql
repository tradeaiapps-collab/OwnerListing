-- Staff allowlist: staff sign in with their own Google account, but only an email with an active invite gets in.
-- Replaces the pre-provisioned app_user.staff_role. History is kept: a role change revokes the old row and inserts a new one.
CREATE TABLE staff_invite (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL CHECK (email = lower(btrim(email)) AND length(email) <= 254 AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  role TEXT NOT NULL CHECK (role IN ('super_admin','compliance','accountant','support','technical','reporting')),
  invited_by UUID REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by UUID REFERENCES app_user(id)
);
-- At most one active invite per email.
CREATE UNIQUE INDEX staff_invite_active_email ON staff_invite(email) WHERE revoked_at IS NULL;

-- Insert only, except that accepted_at and revoked_at/revoked_by may each be set once. Rows are never deleted.
CREATE FUNCTION staff_invite_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'staff_invite rows cannot be deleted'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.email IS DISTINCT FROM OLD.email OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.invited_by IS DISTINCT FROM OLD.invited_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'staff_invite email, role and inviter cannot be changed';
  END IF;
  IF OLD.accepted_at IS NOT NULL AND NEW.accepted_at IS DISTINCT FROM OLD.accepted_at THEN
    RAISE EXCEPTION 'staff_invite accepted_at is already set';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by) THEN
    RAISE EXCEPTION 'staff_invite is already revoked';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER staff_invite_guard BEFORE UPDATE OR DELETE ON staff_invite
  FOR EACH ROW EXECUTE FUNCTION staff_invite_guard();

-- Keep existing staff: each active, pre-provisioned staff account becomes an invite with its current role.
INSERT INTO staff_invite (email, role, accepted_at)
SELECT lower(btrim(email)), staff_role, CASE WHEN google_sub IS NOT NULL THEN now() END
  FROM app_user
 WHERE staff_role IS NOT NULL AND user_type = 'admin' AND status = 'active' AND email IS NOT NULL
   AND lower(btrim(email)) ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
ON CONFLICT DO NOTHING;

-- The invite is now the only source of a staff role.
ALTER TABLE app_user DROP COLUMN staff_role;
