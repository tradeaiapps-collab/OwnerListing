-- Versioned terms and privacy acceptance (insert-only) and per-user settings limits.
-- terms_version, terms_acceptance and user_preference already exist (009, 012); this migration only hardens them and seeds version 1.

-- A published terms version never changes: a new version is a new row.
CREATE TRIGGER terms_version_immutable
  BEFORE UPDATE OR DELETE ON terms_version
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

-- Acceptances are a permanent log: no update, no delete.
CREATE TRIGGER terms_acceptance_append_only
  BEFORE UPDATE OR DELETE ON terms_acceptance
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

CREATE INDEX terms_version_effective_idx ON terms_version (effective_at DESC);

ALTER TABLE user_preference
  ADD CONSTRAINT user_preference_locale_len CHECK (char_length(locale) BETWEEN 2 AND 16),
  ADD CONSTRAINT user_preference_tz_len CHECK (char_length(time_zone) BETWEEN 3 AND 64);

-- Draft terms, pending counsel review. The AI-learning clause is off until counsel signs off the wording.
INSERT INTO terms_version (version, includes_ai_learning_clause, text_reference, effective_at)
VALUES ('2026-10-24', false, '/terms', '2026-10-24T00:00:00Z')
ON CONFLICT (version) DO NOTHING;
