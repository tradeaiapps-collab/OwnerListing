-- Admin-managed staff roles. Built-in roles (super_admin, compliance, accountant, support, technical, reporting, designer) are seeded here and are
-- fixed: their permissions live in code (src/domain/staff-access.ts) and these rows only make the keys referenceable. Custom roles
-- (key prefix custom_) are created and edited by a super admin in /staff/roles. Both tables are insert-only: an edit adds a new version
-- row, and nothing is ever updated or deleted, so the full history of every role is kept.
--
-- Runs after 20261025130000_site_theme.sql, which added 'designer' to the invite role check; designer is kept as a built-in role.
-- Existing invites: staff_invite.role already holds a built-in key. Its values are not changed or copied anywhere; the CHECK listing the
-- six keys is widened to also allow custom_ keys, a foreign key to staff_role_def is added, and the migration stops if any existing
-- invite would not resolve. No invite row is rewritten, so nothing can be lost.
--
-- Rollback (manual, only while no custom role is in use): revoke every invite whose role starts with custom_, then
--   ALTER TABLE staff_invite DROP CONSTRAINT staff_invite_role_fkey; ALTER TABLE staff_invite DROP CONSTRAINT staff_invite_role_check;
--   ALTER TABLE staff_invite ADD CONSTRAINT staff_invite_role_check CHECK (role IN ('super_admin','compliance','accountant','support','technical','reporting','designer')) NOT VALID;
--   DROP VIEW staff_role_current; DROP TABLE staff_role_def_version; DROP TABLE staff_role_def; DROP FUNCTION staff_role_version_guard(); DROP FUNCTION staff_role_def_guard();
--   and delete this file's row from schema_migration. NOT VALID keeps the revoked custom-role history rows readable.

CREATE TABLE staff_role_def (
  key TEXT PRIMARY KEY CHECK (key IN ('super_admin','compliance','accountant','support','technical','reporting','designer') OR key ~ '^custom_[a-z0-9_]{2,40}$'),
  is_system BOOLEAN NOT NULL,
  created_by UUID REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (is_system = (key !~ '^custom_'))
);

CREATE TABLE staff_role_def_version (
  role_key TEXT NOT NULL REFERENCES staff_role_def(key),
  version INTEGER NOT NULL CHECK (version >= 1),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 300),
  -- Permission keys only (lower-case dotted names). Unknown keys are ignored by the application (fail closed).
  permissions TEXT[] NOT NULL DEFAULT '{}' CHECK (array_to_string(permissions, ',') ~ '^([a-z_]+(\.[a-z_]+)+(,|$))*$' AND cardinality(permissions) <= 100),
  disabled BOOLEAN NOT NULL DEFAULT false,
  changed_by UUID REFERENCES app_user(id),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (role_key, version)
);

CREATE FUNCTION staff_role_def_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'staff roles cannot be changed or deleted; add a new version or disable the role';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER staff_role_def_append_only BEFORE UPDATE OR DELETE ON staff_role_def
  FOR EACH ROW EXECUTE FUNCTION staff_role_def_guard();
CREATE TRIGGER staff_role_def_version_append_only BEFORE UPDATE OR DELETE ON staff_role_def_version
  FOR EACH ROW EXECUTE FUNCTION staff_role_def_guard();

-- Versions are consecutive (so two concurrent edits of the same version cannot both land), and a built-in role has exactly one,
-- empty, enabled version: it can never be edited or disabled.
CREATE FUNCTION staff_role_version_guard() RETURNS trigger AS $$
DECLARE
  sys BOOLEAN;
  latest INTEGER;
BEGIN
  SELECT is_system INTO sys FROM staff_role_def WHERE key = NEW.role_key;
  SELECT max(version) INTO latest FROM staff_role_def_version WHERE role_key = NEW.role_key;
  IF NEW.version <> coalesce(latest, 0) + 1 THEN
    RAISE EXCEPTION 'staff role version must follow the current version';
  END IF;
  IF sys AND (NEW.version > 1 OR NEW.disabled OR cardinality(NEW.permissions) > 0) THEN
    RAISE EXCEPTION 'built-in staff roles cannot be changed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER staff_role_version_guard BEFORE INSERT ON staff_role_def_version
  FOR EACH ROW EXECUTE FUNCTION staff_role_version_guard();

-- The definition in force for each role: its latest version.
CREATE VIEW staff_role_current AS
SELECT DISTINCT ON (v.role_key) v.role_key, d.is_system, v.version, v.label, v.description, v.permissions, v.disabled,
       v.changed_by, v.changed_at, d.created_by, d.created_at
  FROM staff_role_def_version v JOIN staff_role_def d ON d.key = v.role_key
 ORDER BY v.role_key, v.version DESC;

INSERT INTO staff_role_def (key, is_system) VALUES
  ('super_admin', true), ('compliance', true), ('accountant', true), ('support', true), ('technical', true), ('reporting', true), ('designer', true);
INSERT INTO staff_role_def_version (role_key, version, label) VALUES
  ('super_admin', 1, 'Super admin'), ('compliance', 1, 'Compliance'), ('accountant', 1, 'Accountant'),
  ('support', 1, 'Support'), ('technical', 1, 'Technical'), ('reporting', 1, 'Reporting'), ('designer', 1, 'Designer');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM staff_invite i WHERE NOT EXISTS (SELECT 1 FROM staff_role_def r WHERE r.key = i.role)) THEN
    RAISE EXCEPTION 'an existing staff_invite has a role that is not a built-in role; fix it before migrating';
  END IF;
END;
$$;

ALTER TABLE staff_invite DROP CONSTRAINT staff_invite_role_check;
ALTER TABLE staff_invite ADD CONSTRAINT staff_invite_role_check
  CHECK (role IN ('super_admin','compliance','accountant','support','technical','reporting','designer') OR role ~ '^custom_[a-z0-9_]{2,40}$');
ALTER TABLE staff_invite ADD CONSTRAINT staff_invite_role_fkey FOREIGN KEY (role) REFERENCES staff_role_def(key);
CREATE INDEX staff_invite_role_active ON staff_invite(role) WHERE revoked_at IS NULL;
