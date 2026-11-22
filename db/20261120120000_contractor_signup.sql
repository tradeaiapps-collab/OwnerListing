-- Contractor (vendor) self sign-up: the email link carries the trade, and the account is created only when the link is used.
-- Contractors choose one of the four trades the contractor profile already supports.
ALTER TABLE email_auth_token DROP CONSTRAINT IF EXISTS email_auth_token_user_type_check;
ALTER TABLE email_auth_token ADD CONSTRAINT email_auth_token_user_type_check CHECK (user_type IN ('owner','agent','buyer','vendor'));
ALTER TABLE email_auth_token ADD COLUMN trade TEXT CHECK (trade IN ('photographer','inspector','pest_control','other'));
-- A trade belongs to contractor sign-ups only.
ALTER TABLE email_auth_token ADD CONSTRAINT email_auth_token_trade_vendor_only CHECK (trade IS NULL OR user_type = 'vendor');
