-- Buyer conversion scores: one snapshot per agent, lead and day, so a score can later be compared with what the buyer did.
-- outcome is filled in by the application when the buyer makes an offer within 30 days of the snapshot ('accepted' if that offer is accepted).
-- A snapshot older than 30 days with no outcome counts as "did not convert". Never deleted by the application.
CREATE TABLE buyer_lead_score (
  agent_user_id UUID NOT NULL REFERENCES app_user(id),
  enquiry_id    UUID NOT NULL REFERENCES enquiry(id),
  snap_date     DATE NOT NULL,
  probability   SMALLINT NOT NULL CHECK (probability BETWEEN 0 AND 100),
  model_probability SMALLINT NOT NULL CHECK (model_probability BETWEEN 0 AND 100),
  tier          TEXT NOT NULL CHECK (tier IN ('red','yellow','green')),
  confidence    TEXT NOT NULL CHECK (confidence IN ('high','medium','low')),
  model_version TEXT NOT NULL CHECK (char_length(model_version) BETWEEN 1 AND 30),
  outcome       TEXT CHECK (outcome IN ('offer','accepted')),
  outcome_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_user_id, enquiry_id, snap_date),
  CHECK ((outcome IS NULL) = (outcome_at IS NULL))
);
CREATE INDEX buyer_lead_score_open_idx ON buyer_lead_score (agent_user_id, created_at) WHERE outcome IS NULL;
