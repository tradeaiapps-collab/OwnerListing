-- Map pin for a listing (search map). WGS84 decimal degrees, set by the owner on the edit page.
-- Both or neither, and only inside Australia's bounds; the domain checks the same (src/domain/listing-details.ts).
ALTER TABLE property_listing
  ADD COLUMN latitude NUMERIC(8,6) CHECK (latitude BETWEEN -44 AND -9),
  ADD COLUMN longitude NUMERIC(9,6) CHECK (longitude BETWEEN 112 AND 154),
  ADD CONSTRAINT property_listing_location_pair CHECK ((latitude IS NULL) = (longitude IS NULL));
-- Map viewport queries over published listings.
CREATE INDEX property_listing_location_idx ON property_listing (latitude, longitude) WHERE status = 'published' AND latitude IS NOT NULL;
