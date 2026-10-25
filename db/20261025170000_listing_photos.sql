-- Listing photo gallery. Two insert-only tables:
--   listing_photo        one row per stored image (metadata already stripped). Never updated or deleted.
--   listing_photo_layout the whole ordered gallery after each change (order, captions, alt text, hidden flags, tour link).
--                        The highest version per listing is the current gallery; earlier versions stay as history.
-- Published files are never deletable: a photo leaves a published gallery only by being hidden or replaced (soft-hide).
CREATE TABLE listing_photo (
  id UUID PRIMARY KEY,
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  kind TEXT NOT NULL CHECK (kind IN ('photo', 'floorplan')),
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
CREATE INDEX listing_photo_listing_idx ON listing_photo (listing_id);
CREATE INDEX listing_photo_uploader_idx ON listing_photo (uploaded_by, uploaded_at);

CREATE TABLE listing_photo_layout (
  id BIGSERIAL PRIMARY KEY,
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  version INT NOT NULL CHECK (version >= 1),
  -- [{"photoId": uuid, "caption": text, "alt": text, "hidden": bool}, ...] in display order; validated by the app.
  entries JSONB NOT NULL CHECK (jsonb_typeof(entries) = 'array' AND jsonb_array_length(entries) <= 120),
  tour_url TEXT CHECK (tour_url IS NULL OR (tour_url LIKE 'https://%' AND length(tour_url) <= 500)),
  changed_by UUID NOT NULL REFERENCES app_user(id),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (listing_id, version)
);

CREATE TRIGGER listing_photo_append_only
  BEFORE UPDATE OR DELETE ON listing_photo
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
CREATE TRIGGER listing_photo_layout_append_only
  BEFORE UPDATE OR DELETE ON listing_photo_layout
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
