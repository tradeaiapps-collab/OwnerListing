-- Elena learning loop. Every suggestion Elena makes, what the person did with it, and how the deal ended. Insert-only evidence.
-- Statistics (acceptance, success, A/B) use every row because they hold no personal text. The suggestion text and per-person patterns
-- are used only where consent_for_training is true (the AI-learning terms clause). Learned settings are PROPOSED by the monthly job and
-- only a super admin can activate them (same rule as the lead qualifier).
CREATE TABLE elena_suggestion (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feature TEXT NOT NULL CHECK (feature IN ('negotiation_coach','enquiry_reply','offer_response','mediation','message_moderation','lead_scoring','pricing','listing_optimization','inspection_responder','valuation','other')),
  suggestion_type TEXT NOT NULL CHECK (char_length(suggestion_type) BETWEEN 1 AND 60),
  suggestion_text TEXT CHECK (suggestion_text IS NULL OR char_length(suggestion_text) <= 5000),
  user_id UUID REFERENCES app_user(id),
  user_role TEXT NOT NULL DEFAULT 'unknown',
  region CHAR(3) CHECK (region IS NULL OR region IN ('NSW','VIC','QLD','WA','SA','TAS','ACT','NT')),
  listing_id UUID REFERENCES property_listing(id),
  offer_id UUID REFERENCES formal_offer(id),
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  experiment_key TEXT,
  arm TEXT,
  consent_for_training BOOLEAN NOT NULL DEFAULT false,
  source TEXT NOT NULL DEFAULT 'direct' CHECK (source IN ('ai_draft','direct','backfill')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX elena_suggestion_feature_idx ON elena_suggestion(feature, suggestion_type, created_at);
CREATE INDEX elena_suggestion_user_idx ON elena_suggestion(user_id, created_at);
CREATE INDEX elena_suggestion_offer_idx ON elena_suggestion(offer_id);

CREATE TABLE elena_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  suggestion_id UUID NOT NULL REFERENCES elena_suggestion(id),
  action TEXT NOT NULL CHECK (action IN ('accepted','rejected','modified','ignored')),
  helpful TEXT CHECK (helpful IN ('yes','no','partial')),
  rating INT CHECK (rating BETWEEN 1 AND 5),
  response_seconds INT CHECK (response_seconds IS NULL OR response_seconds >= 0),
  source TEXT NOT NULL CHECK (source IN ('auto','user','staff')),
  recorded_by UUID REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX elena_feedback_suggestion_idx ON elena_feedback(suggestion_id);
-- One automatic record per suggestion, so a retry cannot double-count.
CREATE UNIQUE INDEX elena_feedback_auto_once ON elena_feedback(suggestion_id) WHERE source = 'auto';

CREATE FUNCTION reject_elena_evidence_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is a permanent record', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER elena_suggestion_no_change BEFORE UPDATE OR DELETE ON elena_suggestion FOR EACH ROW EXECUTE FUNCTION reject_elena_evidence_mutation();
CREATE TRIGGER elena_feedback_no_change BEFORE UPDATE OR DELETE ON elena_feedback FOR EACH ROW EXECUTE FUNCTION reject_elena_evidence_mutation();

-- How a deal ended. Filled automatically from the settlement timeline; staff can add what is not captured (final price, satisfaction).
CREATE TABLE settlement_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id UUID NOT NULL UNIQUE REFERENCES settlement_timeline(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('settled','fell_through')),
  time_to_settlement_days INT CHECK (time_to_settlement_days IS NULL OR time_to_settlement_days >= 0),
  final_price_cents BIGINT CHECK (final_price_cents IS NULL OR final_price_cents > 0),
  negotiation_count INT CHECK (negotiation_count IS NULL OR negotiation_count >= 0),
  user_satisfaction INT CHECK (user_satisfaction BETWEEN 1 AND 5),
  source TEXT NOT NULL CHECK (source IN ('auto','staff')),
  recorded_by UUID REFERENCES app_user(id),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- What Elena has learned about how one person acts. Only from consenting people's own suggestions; used only to tailor that person's own coaching.
CREATE TABLE user_patterns (
  user_id UUID PRIMARY KEY REFERENCES app_user(id),
  profile_data JSONB NOT NULL,
  sample_size INT NOT NULL CHECK (sample_size >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE elena_learned_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version INT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','active','retired')),
  config JSONB NOT NULL,
  evidence JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_by UUID REFERENCES app_user(id),
  activated_at TIMESTAMPTZ,
  CHECK ((status = 'active') = (activated_by IS NOT NULL) OR status = 'retired')
);
CREATE UNIQUE INDEX elena_learned_config_one_active ON elena_learned_config((true)) WHERE status = 'active';

CREATE TABLE elena_experiment (
  key TEXT PRIMARY KEY CHECK (key ~ '^[a-z0-9_]{3,40}$'),
  feature TEXT NOT NULL,
  arms TEXT[] NOT NULL CHECK (cardinality(arms) BETWEEN 2 AND 4),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','stopped')),
  created_by UUID REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Launch with history: every past AI draft becomes a suggestion, and sent / edited / discarded becomes its automatic feedback.
-- Consent is not assumed for history, so none of it is used as training text.
INSERT INTO elena_suggestion (id, feature, suggestion_type, user_id, user_role, region, listing_id, offer_id, source, created_at)
SELECT d.id,
  CASE WHEN d.engine_id = 'elena-coach-rules' THEN 'negotiation_coach' WHEN d.kind = 'enquiry_reply' THEN 'enquiry_reply' ELSE 'offer_response' END,
  COALESCE(d.action, d.intent, 'other'), d.created_by, COALESCE(u.user_type, 'unknown'), l.jurisdiction, d.listing_id, d.offer_id, 'backfill', d.created_at
FROM ai_draft d JOIN app_user u ON u.id = d.created_by JOIN property_listing l ON l.id = d.listing_id;
INSERT INTO elena_feedback (suggestion_id, action, response_seconds, source, created_at)
SELECT d.id, CASE d.status WHEN 'sent' THEN 'accepted' WHEN 'edited_sent' THEN 'modified' ELSE 'rejected' END,
  GREATEST(0, EXTRACT(EPOCH FROM (d.finished_at - d.created_at)))::int, 'auto', d.finished_at
FROM ai_draft d WHERE d.status IN ('sent','edited_sent','discarded') AND d.finished_at IS NOT NULL;
