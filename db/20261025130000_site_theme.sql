-- Admin-controlled site appearance (theme + branding): insert-only versions, a publish log, uploaded logo/favicon files and a single current pointer.
-- Edits become draft versions; "publish" moves the published pointer; revert and reset insert new versions (history is never rewritten).

-- New staff role "designer": may edit the site appearance (permission theme.edit) and nothing else.
ALTER TABLE staff_invite DROP CONSTRAINT IF EXISTS staff_invite_role_check;
ALTER TABLE staff_invite ADD CONSTRAINT staff_invite_role_check
  CHECK (role IN ('super_admin','compliance','accountant','support','technical','reporting','designer'));

-- Uploaded logo and favicon files. Insert-only; the type was detected from the bytes by the server (PNG, JPEG, WebP or ICO; never SVG).
CREATE TABLE site_theme_asset (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name         TEXT        NOT NULL CHECK (name IN ('logo-light','logo-dark','favicon')),
  content_type TEXT        NOT NULL CHECK (content_type IN ('image/png','image/jpeg','image/webp','image/x-icon')),
  bytes        BYTEA       NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 524288),
  sha256       CHAR(64)    NOT NULL,
  width        INTEGER     NOT NULL CHECK (width BETWEEN 1 AND 4096),
  height       INTEGER     NOT NULL CHECK (height BETWEEN 1 AND 4096),
  created_by   UUID        NOT NULL REFERENCES app_user(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every saved draft, revert and reset is a new row. settings is the full validated settings object (no raw CSS, HTML or script).
CREATE TABLE site_theme_version (
  version       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  settings      JSONB       NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
  source        TEXT        NOT NULL CHECK (source IN ('save','revert','reset')),
  reverted_from BIGINT      REFERENCES site_theme_version(version),
  created_by    UUID        NOT NULL REFERENCES app_user(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Who made which version live, and when. Insert-only.
CREATE TABLE site_theme_publish (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version      BIGINT      NOT NULL REFERENCES site_theme_version(version),
  action       TEXT        NOT NULL CHECK (action IN ('publish','revert')),
  published_by UUID        NOT NULL REFERENCES app_user(id),
  published_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX site_theme_publish_version_idx ON site_theme_publish(version);

-- Exactly one row: the draft being edited and the version the public site shows. NULL published_version = built-in defaults.
CREATE TABLE site_theme_current (
  id                BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  draft_version     BIGINT REFERENCES site_theme_version(version),
  published_version BIGINT REFERENCES site_theme_version(version),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO site_theme_current (id) VALUES (true);

CREATE TRIGGER site_theme_asset_append_only BEFORE UPDATE OR DELETE ON site_theme_asset
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
CREATE TRIGGER site_theme_version_append_only BEFORE UPDATE OR DELETE ON site_theme_version
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
CREATE TRIGGER site_theme_publish_append_only BEFORE UPDATE OR DELETE ON site_theme_publish
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

CREATE OR REPLACE FUNCTION reject_site_theme_current_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'site_theme_current cannot be deleted';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER site_theme_current_no_delete BEFORE DELETE ON site_theme_current
  FOR EACH ROW EXECUTE FUNCTION reject_site_theme_current_delete();
