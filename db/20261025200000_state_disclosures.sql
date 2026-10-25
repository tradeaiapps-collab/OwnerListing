-- State disclosure requirements (House Listing Spec 6.1).
-- Versioned per state x sale/rent x residential/commercial. A version is drafted, then approved by a different person; approving
-- retires the previous approved version of that combination. Publishing reads the approved version only (none = blocked).
CREATE TABLE disclosure_config_version (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction CHAR(3) NOT NULL CHECK (jurisdiction IN ('NSW','VIC','QLD','WA','SA','TAS','ACT','NT')),
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('sale','rent')),
  use_class TEXT NOT NULL CHECK (use_class IN ('residential','commercial')),
  version INTEGER NOT NULL CHECK (version >= 1),
  items JSONB NOT NULL CHECK (jsonb_typeof(items) = 'array'),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','retired')),
  note TEXT NOT NULL CHECK (char_length(note) BETWEEN 10 AND 1000),
  -- NULL only for versions seeded by a migration.
  created_by UUID REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by UUID REFERENCES app_user(id),
  approved_at TIMESTAMPTZ,
  approval_reason TEXT CHECK (approval_reason IS NULL OR char_length(approval_reason) BETWEEN 10 AND 1000),
  retired_at TIMESTAMPTZ,
  UNIQUE (jurisdiction, transaction_type, use_class, version),
  CHECK ((status = 'draft') = (approved_by IS NULL AND approved_at IS NULL)),
  CHECK (approved_by IS NULL OR created_by IS NULL OR approved_by <> created_by),
  CHECK ((status = 'retired') = (retired_at IS NOT NULL))
);
-- At most one approved version per combination.
CREATE UNIQUE INDEX disclosure_config_one_approved ON disclosure_config_version (jurisdiction, transaction_type, use_class) WHERE status = 'approved';

-- Items of a version are fixed once it leaves draft; only the status can move forward (approved -> retired). Never deleted.
CREATE OR REPLACE FUNCTION guard_disclosure_config_version() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'disclosure_config_version rows are permanent';
  END IF;
  IF OLD.status <> 'draft' AND (NEW.items IS DISTINCT FROM OLD.items OR NEW.jurisdiction IS DISTINCT FROM OLD.jurisdiction
      OR NEW.transaction_type IS DISTINCT FROM OLD.transaction_type OR NEW.use_class IS DISTINCT FROM OLD.use_class
      OR NEW.version IS DISTINCT FROM OLD.version) THEN
    RAISE EXCEPTION 'an approved disclosure config version cannot be changed; draft a new version';
  END IF;
  IF OLD.status = 'retired' AND NEW.status <> 'retired' THEN
    RAISE EXCEPTION 'a retired disclosure config version cannot be reinstated';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER disclosure_config_version_guard BEFORE UPDATE OR DELETE ON disclosure_config_version
  FOR EACH ROW EXECUTE FUNCTION guard_disclosure_config_version();

-- The owner's submission for each required item and the Compliance decision. satisfied stays the publish gate's flag and is
-- true only when a reviewer verified the item.
ALTER TABLE listing_disclosure
  ADD COLUMN state TEXT NOT NULL DEFAULT 'submitted' CHECK (state IN ('submitted','verified','rejected')),
  ADD COLUMN not_applicable BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN owner_note TEXT CHECK (owner_note IS NULL OR char_length(owner_note) <= 500),
  ADD COLUMN evidence_document_id UUID REFERENCES property_document(id),
  ADD COLUMN submitted_by UUID REFERENCES app_user(id),
  ADD COLUMN submitted_at TIMESTAMPTZ,
  ADD COLUMN review_reason TEXT CHECK (review_reason IS NULL OR char_length(review_reason) BETWEEN 10 AND 1000),
  ADD COLUMN config_version_id UUID REFERENCES disclosure_config_version(id);
UPDATE listing_disclosure SET state = 'verified' WHERE satisfied;
ALTER TABLE listing_disclosure
  ADD CONSTRAINT listing_disclosure_satisfied_state CHECK (satisfied = (state = 'verified')),
  ADD CONSTRAINT listing_disclosure_reviewed CHECK (state = 'submitted' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL)),
  ADD CONSTRAINT listing_disclosure_evidence CHECK (not_applicable OR evidence_document_id IS NOT NULL OR state = 'verified'),
  ADD CONSTRAINT listing_disclosure_no_self_review CHECK (verified_by IS NULL OR submitted_by IS NULL OR verified_by <> submitted_by);
CREATE INDEX listing_disclosure_submitted_idx ON listing_disclosure (submitted_at) WHERE state = 'submitted';

-- The version a published listing passed. Later versions never unpublish it.
ALTER TABLE property_listing ADD COLUMN disclosure_config_version_id UUID REFERENCES disclosure_config_version(id);

-- Queensland (beta) seed: DRAFTS only, from src/config/disclosures.ts. Nothing is required, and nothing publishes in QLD, until
-- Compliance approves them at /staff/disclosures.
INSERT INTO disclosure_config_version (jurisdiction, transaction_type, use_class, version, items, status, note) VALUES
  ('QLD', 'sale', 'residential', 1, '[{"key":"qld_seller_disclosure_statement","label":"Seller disclosure statement (Form 2)","description":"The signed seller disclosure statement, given to buyers before they sign a contract. It covers title, encumbrances, zoning, rates and water charges and any notices or orders on the property.","legalRef":"Property Law Act 2023 (Qld), seller disclosure scheme (from 1 Aug 2025); Property Law Regulation 2024, Form 2","notApplicableAllowed":false},{"key":"qld_title_search","label":"Current title search","description":"A current title search for the lot, as a prescribed certificate attached to the seller disclosure statement.","legalRef":"Property Law Act 2023 (Qld), seller disclosure scheme; prescribed certificates","notApplicableAllowed":false},{"key":"qld_registered_plan","label":"Registered survey plan","description":"A copy of the registered survey plan for the lot, as a prescribed certificate attached to the seller disclosure statement.","legalRef":"Property Law Act 2023 (Qld), seller disclosure scheme; prescribed certificates","notApplicableAllowed":false},{"key":"qld_body_corporate_certificate","label":"Body corporate certificate","description":"For a lot in a community titles scheme: the body corporate certificate (levies, by-laws, insurance, improvements and other prescribed details). Mark not applicable if the lot is not in a scheme.","legalRef":"Property Law Act 2023 (Qld), seller disclosure scheme; Body Corporate and Community Management Act 1997 (Qld)","propertyTypes":["unit","townhouse","other"],"notApplicableAllowed":true},{"key":"qld_pool_safety_sale","label":"Pool safety certificate or notice of no pool safety certificate","description":"If there is a regulated pool (or a shared pool): a current pool safety certificate, or the notice of no pool safety certificate (Form 36) given to the buyer before signing. Mark not applicable if there is no pool.","legalRef":"Building Act 1975 (Qld); Building Regulation 2021 (Qld), Form 36","propertyTypes":["house","unit","townhouse","other"],"notApplicableAllowed":true},{"key":"qld_smoke_alarm_compliance_sale","label":"Smoke alarm compliance","description":"The seller''s declaration that the dwelling has smoke alarms that meet the current Queensland standard (interconnected photoelectric alarms), as stated in the contract.","legalRef":"Fire Services Act 1990 (Qld), Part 9A; Building Fire Safety Regulation 2008 (Qld)","propertyTypes":["house","unit","townhouse"],"notApplicableAllowed":false}]'::jsonb, 'draft', 'Draft by engineering from public sources on 25 Oct 2026. Compliance and counsel must confirm items, wording and references before approving.'),
  ('QLD', 'sale', 'commercial', 1, '[{"key":"qld_seller_disclosure_statement","label":"Seller disclosure statement (Form 2)","description":"The signed seller disclosure statement, given to buyers before they sign a contract. It covers title, encumbrances, zoning, rates and water charges and any notices or orders on the property.","legalRef":"Property Law Act 2023 (Qld), seller disclosure scheme (from 1 Aug 2025); Property Law Regulation 2024, Form 2","notApplicableAllowed":false},{"key":"qld_title_search","label":"Current title search","description":"A current title search for the lot, as a prescribed certificate attached to the seller disclosure statement.","legalRef":"Property Law Act 2023 (Qld), seller disclosure scheme; prescribed certificates","notApplicableAllowed":false},{"key":"qld_registered_plan","label":"Registered survey plan","description":"A copy of the registered survey plan for the lot, as a prescribed certificate attached to the seller disclosure statement.","legalRef":"Property Law Act 2023 (Qld), seller disclosure scheme; prescribed certificates","notApplicableAllowed":false},{"key":"qld_body_corporate_certificate","label":"Body corporate certificate","description":"For a lot in a community titles scheme: the body corporate certificate (levies, by-laws, insurance, improvements and other prescribed details). Mark not applicable if the lot is not in a scheme.","legalRef":"Property Law Act 2023 (Qld), seller disclosure scheme; Body Corporate and Community Management Act 1997 (Qld)","notApplicableAllowed":true}]'::jsonb, 'draft', 'Draft by engineering from public sources on 25 Oct 2026. Compliance and counsel must confirm items, wording and references before approving.'),
  ('QLD', 'rent', 'residential', 1, '[{"key":"qld_smoke_alarm_compliance_rental","label":"Smoke alarm compliance","description":"Evidence the dwelling has compliant interconnected photoelectric smoke alarms, tested and cleaned within 30 days before the tenancy starts (for example a compliance certificate).","legalRef":"Fire Services Act 1990 (Qld), Part 9A; Building Fire Safety Regulation 2008 (Qld)","propertyTypes":["house","unit","townhouse","other"],"notApplicableAllowed":false},{"key":"qld_minimum_housing_standards","label":"Minimum housing standards declaration","description":"The owner''s declaration that the premises meet the minimum housing standards (weatherproof and structurally sound, in good repair, working locks, privacy coverings, plumbing and drainage, kitchen and laundry facilities).","legalRef":"Residential Tenancies and Rooming Accommodation Act 2008 (Qld); Residential Tenancies and Rooming Accommodation Regulation 2009 (Qld), minimum housing standards","propertyTypes":["house","unit","townhouse","other"],"notApplicableAllowed":false},{"key":"qld_pool_safety_rental","label":"Pool safety certificate","description":"If there is a regulated pool (or a shared pool): a current pool safety certificate, which must be in effect before the tenancy is entered into. Mark not applicable if there is no pool.","legalRef":"Building Act 1975 (Qld); Building Regulation 2021 (Qld)","propertyTypes":["house","unit","townhouse","other"],"notApplicableAllowed":true},{"key":"qld_body_corporate_bylaws","label":"Body corporate by-laws","description":"For a lot in a community titles scheme: a copy of the body corporate by-laws, to give the tenant. Mark not applicable if the lot is not in a scheme.","legalRef":"Residential Tenancies and Rooming Accommodation Act 2008 (Qld); Body Corporate and Community Management Act 1997 (Qld)","propertyTypes":["unit","townhouse","other"],"notApplicableAllowed":true}]'::jsonb, 'draft', 'Draft by engineering from public sources on 25 Oct 2026. Compliance and counsel must confirm items, wording and references before approving.'),
  ('QLD', 'rent', 'commercial', 1, '[{"key":"qld_retail_lessor_disclosure","label":"Lessor disclosure statement and draft lease","description":"For a retail shop lease: the lessor disclosure statement and a copy of the proposed lease, given to the prospective tenant at least 7 days before the lease is entered into. Mark not applicable if the Retail Shop Leases Act does not apply (for example over 1,000 m2).","legalRef":"Retail Shop Leases Act 1994 (Qld)","propertyTypes":["retail"],"notApplicableAllowed":true}]'::jsonb, 'draft', 'Draft by engineering from public sources on 25 Oct 2026. Compliance and counsel must confirm items, wording and references before approving.');
