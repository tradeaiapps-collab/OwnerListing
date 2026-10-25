-- Staff can suspend a published listing (hidden from search and the public page) and later reinstate it through the publish gate.
-- Suspension reasons and who acted are in the audit log (listing.suspended / listing.published events).
ALTER TABLE property_listing DROP CONSTRAINT property_listing_status_check;
ALTER TABLE property_listing ADD CONSTRAINT property_listing_status_check
  CHECK (status IN ('draft', 'pending_review', 'published', 'suspended', 'withdrawn'));
