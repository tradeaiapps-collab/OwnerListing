-- Advanced search: amenities (fixed vocabulary, set by the owner) and full-text search over title, address, suburb and description.
-- The vocabulary is mirrored in src/domain/listing-details.ts (AMENITIES); a test keeps the two in step.
ALTER TABLE property_listing
  ADD COLUMN amenities TEXT[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT property_listing_amenities_known CHECK (amenities <@ ARRAY[
    'pool','air_conditioning','garage','balcony','garden','solar','pet_friendly','furnished','ensuite','study','lift','security'
  ]::text[]);
CREATE INDEX property_listing_amenities_idx ON property_listing USING GIN (amenities) WHERE status = 'published';
-- Same expression as src/server/listing-search-sql.ts (SEARCH_DOC); the planner uses the index only when they match exactly.
CREATE INDEX property_listing_fts_idx ON property_listing USING GIN (
  to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(address_text, '') || ' ' || coalesce(suburb, '') || ' ' || coalesce(description, ''))
) WHERE status = 'published';
