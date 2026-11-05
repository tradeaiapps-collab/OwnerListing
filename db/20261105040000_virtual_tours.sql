-- Virtual tours: 360 photos are a third kind of listing photo (equirectangular 2:1 panoramas).
-- The tour link itself already lives in listing_photo_layout.tour_url (append-only, https only).
ALTER TABLE listing_photo DROP CONSTRAINT IF EXISTS listing_photo_kind_check;
ALTER TABLE listing_photo ADD CONSTRAINT listing_photo_kind_check CHECK (kind IN ('photo', 'floorplan', 'photo360'));
