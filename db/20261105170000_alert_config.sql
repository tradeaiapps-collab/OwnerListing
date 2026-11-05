-- Staff-editable thresholds for Elena's admin alerts: one global row per alert type. A missing row means the code default applies, so this
-- table can start empty. Changes are audited by the API (staff.alert_config.updated); the row holds the current value and who set it.
-- Rollback: DROP TABLE alert_config; (alerts then use the built-in defaults).
CREATE TABLE alert_config (
  alert_type TEXT PRIMARY KEY CHECK (alert_type IN ('agent_unanswered','agent_acceptance_gap','agent_slow_reply','area_conversion','area_enquiry_drop','area_quiet')),
  threshold NUMERIC(8,2) NOT NULL CHECK (threshold > 0 AND threshold <= 1000),
  enabled BOOLEAN NOT NULL DEFAULT true,
  updated_by UUID REFERENCES app_user(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
