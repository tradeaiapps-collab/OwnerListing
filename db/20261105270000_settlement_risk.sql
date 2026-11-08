-- Settlement risk predictor (Elena): one current risk row per settlement, plus a record of sales that fell through.
-- The score is rules-based (src/domain/settlement-risk.ts). Rows are rewritten when staff open the risk dashboard; nothing is deleted.

CREATE TABLE settlement_risks (
  settlement_id UUID PRIMARY KEY REFERENCES settlement_timeline(id),
  risk_score SMALLINT NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
  previous_score SMALLINT CHECK (previous_score IS NULL OR previous_score BETWEEN 0 AND 100),
  band TEXT NOT NULL CHECK (band IN ('low','medium','high')),
  primary_risk_factor TEXT,
  -- [{ "key": "finance_overdue", "label": "...", "points": 15 }]
  secondary_risks JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(secondary_risks) = 'array'),
  predicted_fallthrough_date DATE,
  rules_version TEXT NOT NULL,
  scored_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- First time the score reached high, and when it dropped back (or the sale closed). A new high spell clears addressed_at.
  flagged_at TIMESTAMPTZ,
  addressed_at TIMESTAMPTZ
);
CREATE INDEX settlement_risks_score_idx ON settlement_risks(risk_score DESC);

CREATE TABLE fallthrough_history (
  settlement_id UUID PRIMARY KEY REFERENCES settlement_timeline(id),
  fell_through_date DATE NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('buyer_backed_out','financing_denied','inspection_issues','other')),
  stage_at_fall TEXT NOT NULL,
  final_score SMALLINT CHECK (final_score IS NULL OR final_score BETWEEN 0 AND 100),
  lessons_learned TEXT CHECK (lessons_learned IS NULL OR length(lessons_learned) <= 1000),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION reject_fallthrough_history_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'fallthrough_history is a permanent record';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER fallthrough_history_no_delete BEFORE DELETE ON fallthrough_history FOR EACH ROW EXECUTE FUNCTION reject_fallthrough_history_delete();
