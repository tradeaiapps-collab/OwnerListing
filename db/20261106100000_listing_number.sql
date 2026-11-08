-- A short public number for each listing (shown at the top of every chat). Existing listings are numbered in creation order.
CREATE SEQUENCE IF NOT EXISTS listing_number_seq START WITH 10001;
ALTER TABLE property_listing ADD COLUMN IF NOT EXISTS listing_number BIGINT;
UPDATE property_listing p SET listing_number = 10000 + r.n
  FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS n FROM property_listing WHERE listing_number IS NULL) r
  WHERE r.id = p.id;
SELECT setval('listing_number_seq', GREATEST((SELECT COALESCE(max(listing_number), 10000) FROM property_listing), 10000) + 1, false);
ALTER TABLE property_listing ALTER COLUMN listing_number SET DEFAULT nextval('listing_number_seq');
ALTER TABLE property_listing ALTER COLUMN listing_number SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS property_listing_number_idx ON property_listing(listing_number);
