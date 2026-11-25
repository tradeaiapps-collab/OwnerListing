-- Original file names for the duplicate-name check on a listing's photos, floor plans and documents.
-- Nullable: rows added before this migration have no name. Only the cleaned base name is kept (no path), never used as a storage key.
-- Both tables stay insert-only (the append-only trigger on listing_photo still refuses UPDATE and DELETE).
ALTER TABLE listing_photo ADD COLUMN filename TEXT CHECK (filename IS NULL OR length(filename) BETWEEN 1 AND 200);
ALTER TABLE property_document ADD COLUMN filename TEXT CHECK (filename IS NULL OR length(filename) BETWEEN 1 AND 200);
CREATE INDEX listing_photo_filename_idx ON listing_photo (listing_id, lower(filename)) WHERE filename IS NOT NULL;
CREATE INDEX property_document_filename_idx ON property_document (listing_id, lower(filename)) WHERE filename IS NOT NULL;
