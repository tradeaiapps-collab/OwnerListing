-- Buyer-seller disputes during settlement, Elena's mediation rounds and staff actions. Nothing is deleted.
-- Money is only described (the share of a disputed amount the seller covers); nothing here moves it.

CREATE TABLE disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id UUID NOT NULL REFERENCES settlement_timeline(id),
  type TEXT NOT NULL CHECK (type IN ('inspection','financing','repair','cooling_off')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
  initiated_by UUID NOT NULL REFERENCES app_user(id),
  initiated_by_side TEXT NOT NULL CHECK (initiated_by_side IN ('buyer','seller')),
  claim_cents BIGINT CHECK (claim_cents IS NULL OR claim_cents > 0),
  buyer_position TEXT CHECK (buyer_position IS NULL OR length(buyer_position) <= 2000),
  buyer_share_pct SMALLINT CHECK (buyer_share_pct IS NULL OR buyer_share_pct BETWEEN 0 AND 100),
  seller_position TEXT CHECK (seller_position IS NULL OR length(seller_position) <= 2000),
  seller_share_pct SMALLINT CHECK (seller_share_pct IS NULL OR seller_share_pct BETWEEN 0 AND 100),
  status TEXT NOT NULL DEFAULT 'awaiting_position' CHECK (status IN ('awaiting_position','mediating','agreed','escalated','resolved','withdrawn')),
  current_round SMALLINT NOT NULL DEFAULT 0 CHECK (current_round BETWEEN 0 AND 3),
  deadline_at TIMESTAMPTZ NOT NULL,
  escalation_reason TEXT CHECK (escalation_reason IS NULL OR escalation_reason IN ('requested','max_rounds','timeout')),
  escalated_at TIMESTAMPTZ,
  -- How it ended: the seller's agreed share of the amount (for the "similar disputes" history) and a plain-words outcome.
  agreed_seller_share_pct SMALLINT CHECK (agreed_seller_share_pct IS NULL OR agreed_seller_share_pct BETWEEN 0 AND 100),
  outcome TEXT CHECK (outcome IS NULL OR length(outcome) <= 2000),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status IN ('agreed','resolved','withdrawn')) = (resolved_at IS NOT NULL))
);
CREATE INDEX disputes_settlement_idx ON disputes(settlement_id);
CREATE INDEX disputes_status_idx ON disputes(status, deadline_at);
-- One live dispute per type per settlement.
CREATE UNIQUE INDEX disputes_one_open_per_type_idx ON disputes(settlement_id, type) WHERE status IN ('awaiting_position','mediating','escalated');

CREATE TABLE dispute_mediation_rounds (
  dispute_id UUID NOT NULL REFERENCES disputes(id),
  round SMALLINT NOT NULL CHECK (round BETWEEN 1 AND 3),
  elena_suggestion JSONB NOT NULL,
  buyer_response TEXT CHECK (buyer_response IS NULL OR buyer_response IN ('accept','counter','escalate')),
  buyer_counter_pct SMALLINT CHECK (buyer_counter_pct IS NULL OR buyer_counter_pct BETWEEN 0 AND 100),
  buyer_note TEXT CHECK (buyer_note IS NULL OR length(buyer_note) <= 2000),
  seller_response TEXT CHECK (seller_response IS NULL OR seller_response IN ('accept','counter','escalate')),
  seller_counter_pct SMALLINT CHECK (seller_counter_pct IS NULL OR seller_counter_pct BETWEEN 0 AND 100),
  seller_note TEXT CHECK (seller_note IS NULL OR length(seller_note) <= 2000),
  resolved BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (dispute_id, round)
);

CREATE TABLE dispute_staff_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id UUID NOT NULL REFERENCES disputes(id),
  staff_user_id UUID REFERENCES app_user(id),
  -- 'auto_escalated' and 'escalated' are written by the system or a party (staff_user_id is empty or the party), the rest by staff.
  action TEXT NOT NULL CHECK (action IN ('auto_escalated','escalated','claimed','noted','resolved')),
  note TEXT CHECK (note IS NULL OR length(note) <= 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX dispute_staff_actions_idx ON dispute_staff_actions(dispute_id, created_at);

CREATE OR REPLACE FUNCTION reject_dispute_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'dispute records are a permanent record';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER disputes_no_delete BEFORE DELETE ON disputes FOR EACH ROW EXECUTE FUNCTION reject_dispute_delete();
CREATE TRIGGER dispute_mediation_rounds_no_delete BEFORE DELETE ON dispute_mediation_rounds FOR EACH ROW EXECUTE FUNCTION reject_dispute_delete();
CREATE TRIGGER dispute_staff_actions_no_delete BEFORE DELETE ON dispute_staff_actions FOR EACH ROW EXECUTE FUNCTION reject_dispute_delete();

-- The hourly escalation job gets its own cron secret like the others (see /staff/cron-secrets).
ALTER TABLE cron_secret_setting DROP CONSTRAINT cron_secret_setting_job_check;
ALTER TABLE cron_secret_setting ADD CONSTRAINT cron_secret_setting_job_check CHECK (job IN ('automations','staff_automation','disputes'));
