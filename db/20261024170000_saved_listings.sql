-- A buyer's bookmarked listings. A bookmark is the buyer's own list entry (not chat, not a published file), so a row may be deleted.
CREATE TABLE saved_listing (
  buyer_user_id UUID NOT NULL REFERENCES app_user(id),
  listing_id    UUID NOT NULL REFERENCES property_listing(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (buyer_user_id, listing_id)
);
CREATE INDEX saved_listing_buyer_idx ON saved_listing(buyer_user_id, created_at DESC);

-- One alert attempt per saved search per listing, whatever the outcome; a re-run of the publish hook cannot log or send twice.
CREATE UNIQUE INDEX alert_delivery_search_listing_idx ON alert_delivery(saved_search_id, listing_id) WHERE saved_search_id IS NOT NULL;
