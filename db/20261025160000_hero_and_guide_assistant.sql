-- 1. Home hero photo: a fourth site appearance image slot ('hero', up to 1.5 MB). Existing rows are unchanged (logos stay at 512 KB).
-- 2. Guide assistant content (greeting, quick replies, answers): insert-only versions plus an insert-only publish log, like the site theme.
--    The live content is the version in the latest publish row; nothing is ever updated or deleted. Visitor messages are never stored.
--
-- Rollback (manual): DROP TABLE guide_assistant_publish; DROP TABLE guide_assistant_version; and, only when no hero image exists,
--   restore the two site_theme_asset checks from db/20261025130000_site_theme.sql; delete this file's row from schema_migration.

ALTER TABLE site_theme_asset DROP CONSTRAINT IF EXISTS site_theme_asset_name_check;
ALTER TABLE site_theme_asset ADD CONSTRAINT site_theme_asset_name_check CHECK (name IN ('logo-light','logo-dark','favicon','hero'));
ALTER TABLE site_theme_asset DROP CONSTRAINT IF EXISTS site_theme_asset_bytes_check;
ALTER TABLE site_theme_asset ADD CONSTRAINT site_theme_asset_bytes_check
  CHECK (octet_length(bytes) BETWEEN 1 AND 524288 OR (name = 'hero' AND octet_length(bytes) BETWEEN 1 AND 1572864));

-- content is the full validated content object (plain text and https/same-site links only; no HTML).
CREATE TABLE guide_assistant_version (
  version    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  content    JSONB       NOT NULL CHECK (jsonb_typeof(content) = 'object' AND octet_length(content::text) <= 65536),
  created_by UUID        NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE guide_assistant_publish (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version      BIGINT      NOT NULL REFERENCES guide_assistant_version(version),
  published_by UUID        NOT NULL REFERENCES app_user(id),
  published_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX guide_assistant_publish_version_idx ON guide_assistant_publish(version);

CREATE TRIGGER guide_assistant_version_append_only BEFORE UPDATE OR DELETE ON guide_assistant_version
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
CREATE TRIGGER guide_assistant_publish_append_only BEFORE UPDATE OR DELETE ON guide_assistant_publish
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
