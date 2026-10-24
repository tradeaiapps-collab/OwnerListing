-- 1) DB-level guard for the once-per-hour automated offer notice (race noted in PR #55).
--    The service checks the last notice time, but two concurrent buyer messages could both pass that check.
--    At most one automated message per thread per UTC clock hour. The service rule is "60 minutes apart", so any
--    notice it allows lands in a different hour bucket and is never rejected here; a racing second insert is.
CREATE UNIQUE INDEX enquiry_message_one_notice_per_hour_idx
  ON enquiry_message (enquiry_id, date_trunc('hour', sent_at AT TIME ZONE 'UTC'))
  WHERE automated;

-- 2) A buyer's request for a formal offer link, answered by the listing owner. Rows are never deleted.
--    The thread messages about it go through enquiry_message (append-only); this table only holds the state.
CREATE TABLE offer_link_request (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enquiry_id UUID NOT NULL REFERENCES enquiry(id),
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','issued','declined')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  -- Set when issued. The link row itself (offer_link) keeps only the hash.
  token_hash CHAR(64),
  -- The raw token is never stored. This is AES-256-GCM ciphertext ("v1." + base64(iv | ciphertext+tag)), sealed with
  -- the server key OFFER_LINK_TOKEN_KEY and bound to this row's id. Random IV per row. Set to NULL as soon as the link
  -- is used or has expired, and the app refuses to issue or show a link when the key is unset.
  link_ciphertext TEXT,
  CHECK ((status = 'issued') = (token_hash IS NOT NULL)),
  CHECK (link_ciphertext IS NULL OR status = 'issued'),
  CHECK ((status = 'requested') = (decided_at IS NULL))
);
-- One open request per thread.
CREATE UNIQUE INDEX offer_link_request_one_open_idx ON offer_link_request(enquiry_id) WHERE status = 'requested';
CREATE INDEX offer_link_request_enquiry_idx ON offer_link_request(enquiry_id, requested_at DESC);
