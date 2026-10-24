-- Adds 'buyer' to the allowed app_user.user_type values so buyers can sign in with Google.
-- The original CHECK was created inline in 001, so its name is looked up by definition instead of assumed.
DO $$
DECLARE c TEXT;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'app_user'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%user_type%';
  IF c IS NOT NULL THEN
    EXECUTE format('ALTER TABLE app_user DROP CONSTRAINT %I', c);
  END IF;
  ALTER TABLE app_user ADD CONSTRAINT app_user_user_type_check
    CHECK (user_type IN ('owner','agent','buyer','vendor','admin','project_owner','investor'));
END $$;
