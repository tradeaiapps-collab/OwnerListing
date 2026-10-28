-- The guide assistant's character (Elena, Maya, Amara, Sofia or Noor), chosen by staff at /staff/assistant.
-- Insert-only: every change is a new row and the latest row is the live choice. No rows means the default (Elena).
--
-- Rollback (manual): DROP TABLE assistant_persona_choice; delete this file's row from schema_migration.

CREATE TABLE assistant_persona_choice (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  persona    TEXT        NOT NULL CHECK (persona IN ('elena','maya','amara','sofia','noor')),
  chosen_by  UUID        NOT NULL REFERENCES app_user(id),
  chosen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER assistant_persona_choice_append_only BEFORE UPDATE OR DELETE ON assistant_persona_choice
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
