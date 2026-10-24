-- Log of every saved-search alert attempt (sent, failed, provider off, or skipped). Insert-only.
CREATE TABLE alert_delivery (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_user_id   UUID NOT NULL REFERENCES app_user(id),
  channel         TEXT NOT NULL CHECK (channel IN ('email','sms')),
  listing_id      UUID NOT NULL,
  saved_search_id UUID,
  outcome         TEXT NOT NULL CHECK (outcome IN ('sent','failed','not_configured','skipped_no_consent','skipped_duplicate','skipped_no_unsubscribe')),
  attempted_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One delivered alert per buyer per channel per listing.
CREATE UNIQUE INDEX alert_delivery_one_sent_idx ON alert_delivery(buyer_user_id, channel, listing_id) WHERE outcome = 'sent';

CREATE OR REPLACE FUNCTION reject_alert_delivery_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'alert_delivery is insert-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER alert_delivery_no_update
  BEFORE UPDATE OR DELETE ON alert_delivery
  FOR EACH ROW EXECUTE FUNCTION reject_alert_delivery_mutation();
