-- Investor projects module. OFF by default: live only when env INVESTMENT_MODULE_ENABLED=true AND the database switch below is on.
-- The platform holds no money and takes no investment: there are deliberately no payment, deposit, commitment or allocation columns.
-- db/001 created no investment tables (Gate G4); app_user.user_type already allows 'investor', which this module does not use (investors are buyer accounts).

-- Database key of the two-key switch. No row = off.
CREATE TABLE investment_setting (
  key         TEXT PRIMARY KEY CHECK (key = 'investment_module_enabled'),
  enabled     BOOLEAN NOT NULL DEFAULT false,
  updated_by  UUID NOT NULL REFERENCES app_user(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every switch change, insert-only. Turning on records the counsel confirmation and the disclosure version confirmed.
CREATE TABLE investment_setting_history (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enabled             BOOLEAN NOT NULL,
  counsel_confirmed   BOOLEAN NOT NULL,
  disclosure_version  TEXT NOT NULL CHECK (char_length(disclosure_version) BETWEEN 1 AND 64),
  changed_by          UUID NOT NULL REFERENCES app_user(id),
  changed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (NOT enabled OR counsel_confirmed)
);
CREATE INDEX investment_setting_history_at_idx ON investment_setting_history(changed_at DESC);

CREATE TABLE investment_project (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id               UUID NOT NULL REFERENCES app_user(id),
  title                       TEXT NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  location                    TEXT NOT NULL CHECK (char_length(location) BETWEEN 2 AND 120),
  jurisdiction                CHAR(3) NOT NULL CHECK (jurisdiction IN ('NSW','VIC','QLD','WA','SA','TAS','ACT','NT')),
  project_type                TEXT NOT NULL CHECK (project_type IN ('residential_development','commercial_development','land_subdivision','renovation','mixed_use','other')),
  summary                     TEXT NOT NULL CHECK (char_length(summary) BETWEEN 20 AND 4000),
  stage                       TEXT NOT NULL CHECK (stage IN ('concept','planning','approved','construction','completed')),
  funding_target_cents        BIGINT NOT NULL CHECK (funding_target_cents BETWEEN 100 AND 1000000000000),
  minimum_ticket_cents        BIGINT NOT NULL CHECK (minimum_ticket_cents BETWEEN 100 AND 1000000000000),
  timeline                    TEXT NOT NULL CHECK (char_length(timeline) BETWEEN 2 AND 2000),
  risks                       TEXT NOT NULL CHECK (char_length(risks) BETWEEN 20 AND 4000),
  structure_description       TEXT NOT NULL CHECK (char_length(structure_description) BETWEEN 10 AND 4000),
  visible_to                  TEXT NOT NULL DEFAULT 'wholesale_only' CHECK (visible_to IN ('wholesale_only','all_verified')),
  issuer_name                 TEXT NOT NULL CHECK (char_length(issuer_name) BETWEEN 2 AND 200),
  issuer_licence_basis        TEXT NOT NULL CHECK (char_length(issuer_licence_basis) BETWEEN 2 AND 500),
  issuer_statement            TEXT NOT NULL DEFAULT '' CHECK (char_length(issuer_statement) <= 2000),
  issuer_authorised_confirmed BOOLEAN NOT NULL CHECK (issuer_authorised_confirmed),
  status                      TEXT NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review','approved','changes_requested','rejected')),
  version                     INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  review_reason               TEXT CHECK (char_length(review_reason) <= 2000),
  -- Posting model and fee terms copied from investment_posting_setting when first posted; never changed afterwards by the app.
  posting_model               TEXT NOT NULL CHECK (posting_model IN ('commission_on_contract','upfront_fee')),
  commission_type             TEXT NOT NULL CHECK (commission_type IN ('percent','fixed')),
  commission_bps              INTEGER NOT NULL CHECK (commission_bps BETWEEN 0 AND 2000),
  commission_fixed_cents      BIGINT NOT NULL CHECK (commission_fixed_cents BETWEEN 0 AND 100000000),
  upfront_fee_cents           BIGINT NOT NULL CHECK (upfront_fee_cents BETWEEN 0 AND 100000000),
  upfront_fee_status          TEXT NOT NULL CHECK (upfront_fee_status IN ('not_required','unpaid','paid')),
  model2_disclosure           TEXT NOT NULL CHECK (model2_disclosure IN ('off','after_fee','after_contract')),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (minimum_ticket_cents <= funding_target_cents),
  CHECK (posting_model = 'upfront_fee' OR model2_disclosure = 'off')
);
CREATE INDEX investment_project_status_idx ON investment_project(status, updated_at DESC);
CREATE INDEX investment_project_owner_idx ON investment_project(owner_user_id, updated_at DESC);

CREATE TABLE investment_project_status_history (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       UUID NOT NULL REFERENCES investment_project(id),
  from_status      TEXT,
  to_status        TEXT NOT NULL,
  actor_type       TEXT NOT NULL CHECK (actor_type IN ('owner','staff')),
  actor_id         UUID NOT NULL REFERENCES app_user(id),
  reason           TEXT CHECK (char_length(reason) <= 2000),
  project_version  INTEGER NOT NULL,
  at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (actor_type = 'owner' OR char_length(reason) >= 10)
);
CREATE INDEX investment_project_status_history_idx ON investment_project_status_history(project_id, at);

-- Posting model settings (one row; none = defaults: model 1, zero commission). Changes apply to new projects only.
CREATE TABLE investment_posting_setting (
  key                     TEXT PRIMARY KEY CHECK (key = 'posting'),
  model                   TEXT NOT NULL CHECK (model IN ('commission_on_contract','upfront_fee')),
  commission_type         TEXT NOT NULL CHECK (commission_type IN ('percent','fixed')),
  commission_bps          INTEGER NOT NULL CHECK (commission_bps BETWEEN 0 AND 2000),
  commission_fixed_cents  BIGINT NOT NULL CHECK (commission_fixed_cents BETWEEN 0 AND 100000000),
  upfront_fee_cents       BIGINT NOT NULL CHECK (upfront_fee_cents BETWEEN 0 AND 100000000),
  model2_disclosure       TEXT NOT NULL CHECK (model2_disclosure IN ('off','after_fee','after_contract')),
  updated_by              UUID NOT NULL REFERENCES app_user(id),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE investment_posting_setting_history (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  settings    JSONB NOT NULL,
  changed_by  UUID NOT NULL REFERENCES app_user(id),
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Investor self-declaration and acknowledgements, insert-only. The latest row for a user applies.
CREATE TABLE investor_declaration (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES app_user(id),
  category              TEXT NOT NULL CHECK (category IN ('wholesale','sophisticated','retail')),
  ack_not_advice        BOOLEAN NOT NULL CHECK (ack_not_advice),
  ack_not_offer         BOOLEAN NOT NULL CHECK (ack_not_offer),
  ack_no_funds_held     BOOLEAN NOT NULL CHECK (ack_no_funds_held),
  ack_off_platform      BOOLEAN NOT NULL CHECK (ack_off_platform),
  disclosure_version    TEXT NOT NULL CHECK (char_length(disclosure_version) BETWEEN 1 AND 64),
  declared_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX investor_declaration_user_idx ON investor_declaration(user_id, declared_at DESC);

-- Non-binding interest: an indicative range only. Not a commitment, application or allocation.
CREATE TABLE investment_interest (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         UUID NOT NULL REFERENCES investment_project(id),
  investor_user_id   UUID NOT NULL REFERENCES app_user(id),
  amount_min_cents   BIGINT NOT NULL CHECK (amount_min_cents BETWEEN 100 AND 1000000000000),
  amount_max_cents   BIGINT NOT NULL CHECK (amount_max_cents BETWEEN 100 AND 1000000000000),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  contract_status    TEXT NOT NULL DEFAULT 'none' CHECK (contract_status IN ('none','submitted','returned','rejected')),
  UNIQUE (project_id, investor_user_id),
  CHECK (amount_min_cents <= amount_max_cents)
);
CREATE INDEX investment_interest_investor_idx ON investment_interest(investor_user_id, created_at DESC);

-- Permanent record, like enquiry_message.
CREATE TABLE investment_message (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  interest_id     UUID NOT NULL REFERENCES investment_interest(id),
  sender_user_id  UUID NOT NULL REFERENCES app_user(id),
  body            TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX investment_message_thread_idx ON investment_message(interest_id, sent_at);

-- Signed contract copies. Never deleted (published files rule); bytes live in object storage under investments/.
CREATE TABLE investment_contract_file (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  interest_id  UUID NOT NULL REFERENCES investment_interest(id),
  uploaded_by  UUID NOT NULL REFERENCES app_user(id),
  storage_key  TEXT NOT NULL UNIQUE CHECK (storage_key ~ '^investments/[A-Za-z0-9_-]{1,64}/[A-Za-z0-9_-]{1,64}$'),
  sha256       TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes   INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX investment_contract_file_idx ON investment_contract_file(interest_id, uploaded_at);

CREATE TABLE investment_contract_history (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  interest_id  UUID NOT NULL REFERENCES investment_interest(id),
  from_status  TEXT NOT NULL,
  to_status    TEXT NOT NULL,
  actor_type   TEXT NOT NULL CHECK (actor_type IN ('investor','staff')),
  actor_id     UUID NOT NULL REFERENCES app_user(id),
  reason       TEXT CHECK (char_length(reason) <= 2000),
  at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Model 1 platform fee, invoiced to the poster after the signed contract is returned. Never taken from investment money.
CREATE TABLE investment_fee (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  interest_id    UUID NOT NULL UNIQUE REFERENCES investment_interest(id),
  project_id     UUID NOT NULL REFERENCES investment_project(id),
  owner_user_id  UUID NOT NULL REFERENCES app_user(id),
  amount_cents   BIGINT NOT NULL CHECK (amount_cents BETWEEN 0 AND 100000000000),
  status         TEXT NOT NULL DEFAULT 'due' CHECK (status IN ('due','paid','waived')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX investment_fee_owner_idx ON investment_fee(owner_user_id, created_at DESC);

CREATE TABLE investment_fee_history (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fee_id       UUID NOT NULL REFERENCES investment_fee(id),
  from_status  TEXT,
  to_status    TEXT NOT NULL CHECK (to_status IN ('due','paid','waived')),
  actor_id     UUID NOT NULL REFERENCES app_user(id),
  reason       TEXT CHECK (char_length(reason) <= 2000),
  at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION reject_investment_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is insert-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['investment_setting_history','investment_posting_setting_history','investment_project_status_history','investor_declaration',
                          'investment_message','investment_contract_file','investment_contract_history','investment_fee_history'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_investment_ledger_mutation()', t || '_no_update', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_investment_ledger_mutation()', t || '_no_truncate', t);
  END LOOP;
END $$;

-- Posting terms are fixed when a project is posted: no later update may change them (the upfront fee may only go unpaid -> paid).
CREATE OR REPLACE FUNCTION reject_investment_terms_change() RETURNS trigger AS $$
BEGIN
  IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.posting_model IS DISTINCT FROM OLD.posting_model OR NEW.commission_type IS DISTINCT FROM OLD.commission_type
     OR NEW.commission_bps IS DISTINCT FROM OLD.commission_bps OR NEW.commission_fixed_cents IS DISTINCT FROM OLD.commission_fixed_cents
     OR NEW.upfront_fee_cents IS DISTINCT FROM OLD.upfront_fee_cents OR NEW.model2_disclosure IS DISTINCT FROM OLD.model2_disclosure
     OR (NEW.upfront_fee_status IS DISTINCT FROM OLD.upfront_fee_status AND NOT (OLD.upfront_fee_status = 'unpaid' AND NEW.upfront_fee_status = 'paid')) THEN
    RAISE EXCEPTION 'investment_project posting terms are fixed when posted';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER investment_project_terms_fixed BEFORE UPDATE ON investment_project FOR EACH ROW EXECUTE FUNCTION reject_investment_terms_change();
CREATE TRIGGER investment_project_no_delete BEFORE DELETE OR TRUNCATE ON investment_project FOR EACH STATEMENT EXECUTE FUNCTION reject_investment_ledger_mutation();

-- A fee keeps its amount, parties and project; its status only moves due -> paid or due -> waived.
CREATE OR REPLACE FUNCTION reject_investment_fee_change() RETURNS trigger AS $$
BEGIN
  IF NEW.amount_cents IS DISTINCT FROM OLD.amount_cents OR NEW.interest_id IS DISTINCT FROM OLD.interest_id OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'due' AND NEW.status IN ('paid','waived'))) THEN
    RAISE EXCEPTION 'investment_fee amount is fixed and settled fees are final';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER investment_fee_fixed BEFORE UPDATE ON investment_fee FOR EACH ROW EXECUTE FUNCTION reject_investment_fee_change();
CREATE TRIGGER investment_fee_no_delete BEFORE DELETE OR TRUNCATE ON investment_fee FOR EACH STATEMENT EXECUTE FUNCTION reject_investment_ledger_mutation();
