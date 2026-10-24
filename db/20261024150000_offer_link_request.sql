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
  -- SECURITY REVIEW: the raw token is held here, in plaintext, so the buyer can open the link from the thread later.
  -- It is single-use, expires in 24 hours, and only works for this buyer signed in. It is returned only while the
  -- offer_link row is unused and unexpired. Review whether to encrypt it or shorten its life.
  delivered_token TEXT,
  CHECK ((status = 'issued') = (token_hash IS NOT NULL AND delivered_token IS NOT NULL)),
  CHECK ((status = 'requested') = (decided_at IS NULL))
);
-- One open request per thread.
CREATE UNIQUE INDEX offer_link_request_one_open_idx ON offer_link_request(enquiry_id) WHERE status = 'requested';
CREATE INDEX offer_link_request_enquiry_idx ON offer_link_request(enquiry_id, requested_at DESC);
