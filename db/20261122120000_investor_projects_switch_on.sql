-- Turns on the database key of the investor projects module (second key; env INVESTMENT_MODULE_ENABLED is the first).
-- Recorded on the owner's written statement in the project thread on 22 Nov 2026 (about 8:41 pm Brisbane):
-- "Counsel has approved the investor documents". The history row below carries that confirmation under the owner's account.
-- The disclosure text itself is still the PLACEHOLDER version (src/config/investment-disclosure.ts): counsel must replace it,
-- which needs a new version and a fresh confirmation (docs/COUNSEL_QUESTIONS.md 23d).
-- Idempotent: does nothing if the switch already has a row, or if no signed-in non-admin account exists yet.
DO $$
DECLARE
  who UUID;
BEGIN
  IF EXISTS (SELECT 1 FROM investment_setting WHERE key = 'investment_module_enabled') THEN
    RETURN;
  END IF;

  SELECT id INTO who FROM app_user
   WHERE lower(email) = 'falah.joon@gmail.com' AND user_type IN ('owner', 'agent', 'buyer', 'vendor') AND deleted_at IS NULL
   LIMIT 1;
  IF who IS NULL THEN
    SELECT id INTO who FROM app_user
     WHERE user_type IN ('owner', 'agent', 'buyer') AND deleted_at IS NULL
     ORDER BY created_at ASC LIMIT 1;
  END IF;
  IF who IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO investment_setting (key, enabled, updated_by) VALUES ('investment_module_enabled', true, who);
  INSERT INTO investment_setting_history (enabled, counsel_confirmed, disclosure_version, changed_by)
  VALUES (true, true, '2026-10-25-draft-1', who);
END
$$;
