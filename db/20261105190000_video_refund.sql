-- Real Stripe refunds for tour videos that end failed after a buyer paid. One row per paid purchase, ever (UNIQUE purchase_id), so a repeat
-- failure, a retried queue run or a webhook replay can never refund the same payment twice. Staff read this as the refund audit trail.
ALTER TABLE video_purchase ADD COLUMN payment_intent_id TEXT;

CREATE TABLE video_refund (
  id UUID PRIMARY KEY,
  purchase_id UUID NOT NULL UNIQUE REFERENCES video_purchase(id),
  video_id UUID NOT NULL REFERENCES listing_video(id),
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  buyer_id UUID NOT NULL REFERENCES app_user(id),
  amount_cents INT NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'aud' CHECK (currency = 'aud'),
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  stripe_refund_id TEXT,
  attempts INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT NOT NULL DEFAULT '' CHECK (char_length(last_error) <= 500),
  notified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  refunded_at TIMESTAMPTZ
);
CREATE INDEX video_refund_listing_idx ON video_refund (listing_id, created_at DESC);
CREATE INDEX video_refund_queue_idx ON video_refund (next_attempt_at) WHERE status <> 'succeeded';
