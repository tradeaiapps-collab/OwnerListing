-- Elena speaks the buyer's language. Saved language choice, the last language seen from a person, the language each
-- assistant question was written in, and machine translations kept beside (never instead of) the English originals.
-- Translations are append-only like the records they translate.
--
-- Rollback (manual): DROP TABLE ml_translation; ALTER TABLE enquiry_assistant_turn DROP COLUMN language;
-- ALTER TABLE user_preference DROP COLUMN chat_language, DROP COLUMN last_detected_language; delete this file's row from schema_migration.

ALTER TABLE user_preference
  ADD COLUMN chat_language TEXT,            -- NULL = detect from what they write
  ADD COLUMN last_detected_language TEXT;
ALTER TABLE enquiry_assistant_turn ADD COLUMN language TEXT;

CREATE TABLE ml_translation (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       TEXT        NOT NULL CHECK (kind IN ('turn_answer','turn_question','message')),
  ref_id     UUID        NOT NULL,
  locale     TEXT        NOT NULL,
  text       TEXT        NOT NULL CHECK (char_length(text) BETWEEN 1 AND 12000),
  machine    BOOLEAN     NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (kind, ref_id, locale)
);

CREATE TRIGGER ml_translation_append_only BEFORE UPDATE OR DELETE ON ml_translation
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
