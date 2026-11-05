-- DocuSign signers are emailed by the platform (embedded signing sends no DocuSign email). notified_at = last request or resend;
-- reminded_at = the one automatic reminder, claimed before it is sent so it never goes twice. Only pending signers are ever updated.
ALTER TABLE signing_signer ADD COLUMN notified_at TIMESTAMPTZ, ADD COLUMN reminded_at TIMESTAMPTZ;
CREATE INDEX signing_signer_reminder_idx ON signing_signer(notified_at) WHERE status = 'pending' AND reminded_at IS NULL;
