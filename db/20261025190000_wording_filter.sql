-- Anti-discrimination wording filter (House Listing Spec 6.4).
-- Listings get an owner-written description (scanned before publishing). wording_flag records each blocking match from a real
-- publish attempt so Compliance can review it: "cleared" lets that exact match publish on that listing (a lawful exception, such
-- as seniors housing); "upheld" keeps it blocked. Rows are never deleted.
ALTER TABLE property_listing
  ADD COLUMN description TEXT CHECK (description IS NULL OR char_length(description) BETWEEN 1 AND 5000);

CREATE TABLE wording_flag (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES property_listing(id),
  field TEXT NOT NULL CHECK (field IN ('title', 'description')),
  -- field + lower-cased match with spaces collapsed (src/domain/discrimination-filter.ts flagKey)
  flag_key TEXT NOT NULL CHECK (char_length(flag_key) <= 400),
  match_text TEXT NOT NULL CHECK (char_length(match_text) <= 300),
  category TEXT NOT NULL CHECK (category IN ('familial_status','age','race','religion','sex','sexuality_gender',
    'relationship_status','disability','income_source','occupation')),
  rule_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'cleared', 'upheld')),
  raised_by UUID NOT NULL REFERENCES app_user(id),
  first_raised_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_raised_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  reviewed_by UUID REFERENCES app_user(id),
  reviewed_at TIMESTAMPTZ,
  review_reason TEXT CHECK (review_reason IS NULL OR char_length(review_reason) BETWEEN 10 AND 1000),
  UNIQUE (listing_id, flag_key),
  CHECK ((status = 'open') = (reviewed_by IS NULL AND reviewed_at IS NULL AND review_reason IS NULL)),
  -- Nobody reviews a flag they raised (an owner who is also staff cannot clear their own listing's wording).
  CHECK (reviewed_by IS NULL OR reviewed_by <> raised_by)
);
CREATE INDEX wording_flag_open_idx ON wording_flag (last_raised_at) WHERE status = 'open';

CREATE OR REPLACE FUNCTION reject_wording_flag_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'wording_flag rows are permanent';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER wording_flag_no_delete BEFORE DELETE ON wording_flag
  FOR EACH ROW EXECUTE FUNCTION reject_wording_flag_delete();

-- The spec's admin case kind for discrimination escalations (a buyer mentioning discrimination pauses the AI and opens one).
ALTER TABLE admin_case DROP CONSTRAINT admin_case_kind_check;
ALTER TABLE admin_case ADD CONSTRAINT admin_case_kind_check
  CHECK (kind IN ('trust_account_verification','licence_verification','identity_verification','discrimination_flag','other'));
