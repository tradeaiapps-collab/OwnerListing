CREATE OR REPLACE FUNCTION reject_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is an append-only record', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

-- Security review (PRs #51-#56): tables documented as insert-only had no database guard.
-- Prices, payment events and document deletion requests are a permanent record; changes are new rows.
CREATE TRIGGER plan_price_append_only
  BEFORE UPDATE OR DELETE ON plan_price
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
CREATE TRIGGER add_on_price_append_only
  BEFORE UPDATE OR DELETE ON add_on_price
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
CREATE TRIGGER payment_event_append_only
  BEFORE UPDATE OR DELETE ON payment_event
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
CREATE TRIGGER document_deletion_request_append_only
  BEFORE UPDATE OR DELETE ON document_deletion_request
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
