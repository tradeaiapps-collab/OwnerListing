-- Fixed-window counters for the buyer offer submit route. Buckets are SHA-256 hashes (of the link token hash or of the
-- client IP), so no raw IP address or token is stored. Rows older than a day can be deleted by a housekeeping job.
CREATE TABLE IF NOT EXISTS offer_submit_attempt (
  bucket       CHAR(64)    NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  hits         INTEGER     NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
