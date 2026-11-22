-- Deposits held in trust. The platform never holds money: the buyer pays the deposit into the solicitor's verified trust
-- account (trust_account, db/006). These tables are the record of what is owed, what the bank shows was received, and the
-- staff-approved instruction to release it to the seller or refund it to the buyer. Money is whole cents.
-- Ledger movements are insert-only; nothing here is ever deleted; every change is also an audit_event.

CREATE TABLE deposit_holding (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  offer_id UUID NOT NULL UNIQUE REFERENCES formal_offer(id),
  trust_account_id UUID NOT NULL REFERENCES trust_account(id),
  -- Quoted by the buyer on the bank transfer so a statement line can be matched to this deposit.
  reference TEXT NOT NULL UNIQUE CHECK (reference ~ '^DEP-[0-9A-Z]{6}$'),
  required_cents BIGINT NOT NULL CHECK (required_cents > 0 AND required_cents <= 100000000000),
  due_date DATE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','released','refunded','cancelled')),
  closed_reason TEXT,
  created_by UUID NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX deposit_holding_status_idx ON deposit_holding(status, created_at DESC);
CREATE INDEX deposit_holding_account_idx ON deposit_holding(trust_account_id);

-- A request to pay the held deposit out of trust. Approved only by a second, different staff member.
CREATE TABLE deposit_release (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  holding_id UUID NOT NULL REFERENCES deposit_holding(id),
  kind TEXT NOT NULL CHECK (kind IN ('release','refund')),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) >= 10),
  settlement_confirmed BOOLEAN NOT NULL DEFAULT false,
  requested_by UUID NOT NULL REFERENCES app_user(id),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by UUID REFERENCES app_user(id),
  decided_at TIMESTAMPTZ,
  decision_reason TEXT,
  CHECK (kind = 'refund' OR settlement_confirmed),
  CHECK ((status = 'pending') = (decided_by IS NULL AND decided_at IS NULL)),
  CHECK (decided_by IS NULL OR decided_by <> requested_by)
);
CREATE UNIQUE INDEX deposit_release_one_pending ON deposit_release(holding_id) WHERE status = 'pending';

-- The ledger. receipt = money the bank shows arrived in trust; release/refund = approved payment out of trust.
CREATE TABLE deposit_movement (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  holding_id UUID NOT NULL REFERENCES deposit_holding(id),
  kind TEXT NOT NULL CHECK (kind IN ('receipt','release','refund')),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  occurred_on DATE NOT NULL,
  bank_reference TEXT CHECK (bank_reference IS NULL OR length(bank_reference) <= 100),
  release_id UUID UNIQUE REFERENCES deposit_release(id),
  recorded_by UUID NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((kind = 'receipt') = (release_id IS NULL))
);
CREATE INDEX deposit_movement_holding_idx ON deposit_movement(holding_id, occurred_on);

-- Bank statement lines for a trust account, imported from the bank's CSV export, used to reconcile the ledger.
CREATE TABLE trust_statement_import (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trust_account_id UUID NOT NULL REFERENCES trust_account(id),
  file_name TEXT,
  lines_added INTEGER NOT NULL,
  lines_skipped INTEGER NOT NULL,
  imported_by UUID NOT NULL REFERENCES app_user(id),
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE trust_statement_line (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id UUID NOT NULL REFERENCES trust_statement_import(id),
  trust_account_id UUID NOT NULL REFERENCES trust_account(id),
  line_date DATE NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents <> 0),
  description TEXT NOT NULL DEFAULT '',
  reference TEXT NOT NULL DEFAULT '',
  -- Hash of the line's content, so importing an overlapping statement does not add a line twice.
  fingerprint CHAR(64) NOT NULL,
  matched_movement_id UUID UNIQUE REFERENCES deposit_movement(id),
  matched_by UUID REFERENCES app_user(id),
  matched_at TIMESTAMPTZ,
  UNIQUE (trust_account_id, fingerprint),
  CHECK ((matched_movement_id IS NULL) = (matched_by IS NULL AND matched_at IS NULL))
);
CREATE INDEX trust_statement_line_account_idx ON trust_statement_line(trust_account_id, line_date DESC);

CREATE OR REPLACE FUNCTION reject_escrow_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are a permanent record', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER deposit_holding_no_delete BEFORE DELETE ON deposit_holding FOR EACH ROW EXECUTE FUNCTION reject_escrow_change();
CREATE TRIGGER deposit_release_no_delete BEFORE DELETE ON deposit_release FOR EACH ROW EXECUTE FUNCTION reject_escrow_change();
CREATE TRIGGER deposit_movement_insert_only BEFORE UPDATE OR DELETE ON deposit_movement FOR EACH ROW EXECUTE FUNCTION reject_escrow_change();
CREATE TRIGGER trust_statement_import_insert_only BEFORE UPDATE OR DELETE ON trust_statement_import FOR EACH ROW EXECUTE FUNCTION reject_escrow_change();
CREATE TRIGGER trust_statement_line_no_delete BEFORE DELETE ON trust_statement_line FOR EACH ROW EXECUTE FUNCTION reject_escrow_change();
