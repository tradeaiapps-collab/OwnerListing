-- Plans must exist before an admin can price them (plan_price references plan). Entitlements match src/domain/plans.ts.
INSERT INTO plan (id, name, max_photos, storage_gb, features) VALUES
  ('basic', 'Basic', 15, 1, '[]'::jsonb),
  ('standard', 'Standard', 40, 10, '["video","photo_360","ai_description","ai_auto_reply"]'::jsonb),
  ('premium', 'Premium', 100, 50, '["video","photo_360","video_360","ai_description","ai_auto_reply","ai_applicant_report","contract_drafting"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- An invoice can be the flat fee for one listing's plan. A listing has at most one pending or paid invoice, which makes checkout idempotent.
ALTER TABLE invoice
  ADD COLUMN listing_id UUID REFERENCES property_listing(id),
  ADD COLUMN plan_id TEXT REFERENCES plan(id);
CREATE UNIQUE INDEX invoice_one_live_per_listing ON invoice (listing_id)
  WHERE listing_id IS NOT NULL AND status IN ('pending', 'paid');
