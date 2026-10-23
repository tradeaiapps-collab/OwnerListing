-- Interim publish gates, false until the billing and terms modules set them (fail closed).
ALTER TABLE property_listing
  ADD COLUMN listing_fee_paid BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN terms_accepted BOOLEAN NOT NULL DEFAULT false;

-- Google account link. The Google subject id is the stable identity; email can change.
ALTER TABLE app_user ADD COLUMN google_sub TEXT UNIQUE;
