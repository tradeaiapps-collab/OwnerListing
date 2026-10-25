-- Super-admin AI on/off switch (/staff/ai). Insert-only history: the latest row wins; no rows means AI is OFF (the default).
-- The switch alone does nothing: the server also needs AI_ENGINE=ollama and a reachable self-hosted model server.
CREATE TABLE ai_switch_event (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  enabled    BOOLEAN     NOT NULL,
  reason     TEXT        NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 300),
  changed_by UUID        NOT NULL REFERENCES app_user(id),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER ai_switch_event_append_only BEFORE UPDATE OR DELETE ON ai_switch_event
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
