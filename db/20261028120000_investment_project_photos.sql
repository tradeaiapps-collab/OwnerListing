-- Investor project photo gallery. Same shape and rules as the listing gallery (20261025170000_listing_photos.sql):
--   investment_project_photo         one row per stored image (metadata already stripped). Never updated or deleted.
--   investment_project_photo_layout  the whole ordered gallery after each change (order, captions, alt text, hidden flags).
--                                    The highest version per project is the current gallery; earlier versions stay as history.
-- Files are never deletable: a photo leaves the gallery only by being hidden or replaced.
CREATE TABLE investment_project_photo (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES investment_project(id),
  uploaded_by UUID NOT NULL REFERENCES app_user(id),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  width INT NOT NULL CHECK (width BETWEEN 1 AND 12000),
  height INT NOT NULL CHECK (height BETWEEN 1 AND 12000),
  size_bytes INT NOT NULL CHECK (size_bytes BETWEEN 1 AND 10000000),
  sha256 CHAR(64) NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  thumb_key TEXT UNIQUE,
  medium_key TEXT UNIQUE,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX investment_project_photo_project_idx ON investment_project_photo (project_id);
CREATE INDEX investment_project_photo_uploader_idx ON investment_project_photo (uploaded_by, uploaded_at);

CREATE TABLE investment_project_photo_layout (
  id BIGSERIAL PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES investment_project(id),
  version INT NOT NULL CHECK (version >= 1),
  -- [{"photoId": uuid, "caption": text, "alt": text, "hidden": bool}, ...] in display order; validated by the app.
  entries JSONB NOT NULL CHECK (jsonb_typeof(entries) = 'array' AND jsonb_array_length(entries) <= 120),
  changed_by UUID NOT NULL REFERENCES app_user(id),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, version)
);

CREATE TRIGGER investment_project_photo_append_only
  BEFORE UPDATE OR DELETE ON investment_project_photo
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
CREATE TRIGGER investment_project_photo_layout_append_only
  BEFORE UPDATE OR DELETE ON investment_project_photo_layout
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
