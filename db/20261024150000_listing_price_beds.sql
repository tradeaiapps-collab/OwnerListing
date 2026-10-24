-- Asking price (sale) or weekly rent (rent) in AUD cents, plus suburb, postcode, bedrooms, bathrooms and parking.
-- All optional: existing listings stay valid. Price is validated against the listing's transaction type.
ALTER TABLE property_listing
  ADD COLUMN suburb TEXT CHECK (suburb IS NULL OR char_length(suburb) BETWEEN 1 AND 80),
  ADD COLUMN postcode CHAR(4) CHECK (postcode IS NULL OR postcode ~ '^[0-9]{4}$'),
  ADD COLUMN price_cents BIGINT CHECK (price_cents IS NULL OR price_cents > 0),
  ADD COLUMN bedrooms SMALLINT CHECK (bedrooms IS NULL OR bedrooms BETWEEN 0 AND 20),
  ADD COLUMN bathrooms SMALLINT CHECK (bathrooms IS NULL OR bathrooms BETWEEN 0 AND 20),
  ADD COLUMN parking SMALLINT CHECK (parking IS NULL OR parking BETWEEN 0 AND 20),
  ADD CONSTRAINT property_listing_price_by_type CHECK (
    price_cents IS NULL OR price_cents <= CASE WHEN transaction_type = 'rent' THEN 10000000 ELSE 100000000000 END
  );

CREATE INDEX listing_browse_price_idx ON property_listing (transaction_type, price_cents, id) WHERE status = 'published';
CREATE INDEX listing_browse_postcode_idx ON property_listing (postcode) WHERE status = 'published';
CREATE INDEX listing_browse_suburb_idx ON property_listing (lower(suburb) text_pattern_ops) WHERE status = 'published';
