import type { DisclosureItem } from "../domain/disclosure-config";
import type { Jurisdiction } from "../domain/jurisdiction";

/**
 * Queensland draft disclosure requirements (beta state). Seeded as DRAFT versions by db/20261025200000_state_disclosures.sql;
 * they do nothing until a Compliance user reviews and approves them at /staff/disclosures. Publishing in Queensland stays blocked
 * until then (fail closed).
 *
 * Drafted by engineering from public sources on 25 Oct 2026, not legal advice. Compliance and Australian counsel confirm the list,
 * the wording and the legal references before approving. The live requirements are the approved versions in the database; this file
 * is only the seed (tests/disclosure-config.test.ts keeps the migration and this file identical).
 *
 * Keys are stable: never rename one (listings store it). Retire it in a new version and add a new key instead.
 */

const SELLER_DISCLOSURE: DisclosureItem = {
  key: "qld_seller_disclosure_statement",
  label: "Seller disclosure statement (Form 2)",
  description: "The signed seller disclosure statement, given to buyers before they sign a contract. It covers title, encumbrances, zoning, rates and water charges and any notices or orders on the property.",
  legalRef: "Property Law Act 2023 (Qld), seller disclosure scheme (from 1 Aug 2025); Property Law Regulation 2024, Form 2",
  notApplicableAllowed: false
};

const TITLE_SEARCH: DisclosureItem = {
  key: "qld_title_search",
  label: "Current title search",
  description: "A current title search for the lot, as a prescribed certificate attached to the seller disclosure statement.",
  legalRef: "Property Law Act 2023 (Qld), seller disclosure scheme; prescribed certificates",
  notApplicableAllowed: false
};

const REGISTERED_PLAN: DisclosureItem = {
  key: "qld_registered_plan",
  label: "Registered survey plan",
  description: "A copy of the registered survey plan for the lot, as a prescribed certificate attached to the seller disclosure statement.",
  legalRef: "Property Law Act 2023 (Qld), seller disclosure scheme; prescribed certificates",
  notApplicableAllowed: false
};

const BODY_CORPORATE_SALE = (types: DisclosureItem["propertyTypes"]): DisclosureItem => ({
  key: "qld_body_corporate_certificate",
  label: "Body corporate certificate",
  description: "For a lot in a community titles scheme: the body corporate certificate (levies, by-laws, insurance, improvements and other prescribed details). Mark not applicable if the lot is not in a scheme.",
  legalRef: "Property Law Act 2023 (Qld), seller disclosure scheme; Body Corporate and Community Management Act 1997 (Qld)",
  ...(types ? { propertyTypes: types } : {}),
  notApplicableAllowed: true
});

const POOL_SALE: DisclosureItem = {
  key: "qld_pool_safety_sale",
  label: "Pool safety certificate or notice of no pool safety certificate",
  description: "If there is a regulated pool (or a shared pool): a current pool safety certificate, or the notice of no pool safety certificate (Form 36) given to the buyer before signing. Mark not applicable if there is no pool.",
  legalRef: "Building Act 1975 (Qld); Building Regulation 2021 (Qld), Form 36",
  propertyTypes: ["house", "unit", "townhouse", "other"],
  notApplicableAllowed: true
};

const SMOKE_ALARMS_SALE: DisclosureItem = {
  key: "qld_smoke_alarm_compliance_sale",
  label: "Smoke alarm compliance",
  description: "The seller's declaration that the dwelling has smoke alarms that meet the current Queensland standard (interconnected photoelectric alarms), as stated in the contract.",
  legalRef: "Fire Services Act 1990 (Qld), Part 9A; Building Fire Safety Regulation 2008 (Qld)",
  propertyTypes: ["house", "unit", "townhouse"],
  notApplicableAllowed: false
};

const SMOKE_ALARMS_RENT: DisclosureItem = {
  key: "qld_smoke_alarm_compliance_rental",
  label: "Smoke alarm compliance",
  description: "Evidence the dwelling has compliant interconnected photoelectric smoke alarms, tested and cleaned within 30 days before the tenancy starts (for example a compliance certificate).",
  legalRef: "Fire Services Act 1990 (Qld), Part 9A; Building Fire Safety Regulation 2008 (Qld)",
  propertyTypes: ["house", "unit", "townhouse", "other"],
  notApplicableAllowed: false
};

const MINIMUM_HOUSING_STANDARDS: DisclosureItem = {
  key: "qld_minimum_housing_standards",
  label: "Minimum housing standards declaration",
  description: "The owner's declaration that the premises meet the minimum housing standards (weatherproof and structurally sound, in good repair, working locks, privacy coverings, plumbing and drainage, kitchen and laundry facilities).",
  legalRef: "Residential Tenancies and Rooming Accommodation Act 2008 (Qld); Residential Tenancies and Rooming Accommodation Regulation 2009 (Qld), minimum housing standards",
  propertyTypes: ["house", "unit", "townhouse", "other"],
  notApplicableAllowed: false
};

const POOL_RENT: DisclosureItem = {
  key: "qld_pool_safety_rental",
  label: "Pool safety certificate",
  description: "If there is a regulated pool (or a shared pool): a current pool safety certificate, which must be in effect before the tenancy is entered into. Mark not applicable if there is no pool.",
  legalRef: "Building Act 1975 (Qld); Building Regulation 2021 (Qld)",
  propertyTypes: ["house", "unit", "townhouse", "other"],
  notApplicableAllowed: true
};

const BY_LAWS_RENT: DisclosureItem = {
  key: "qld_body_corporate_bylaws",
  label: "Body corporate by-laws",
  description: "For a lot in a community titles scheme: a copy of the body corporate by-laws, to give the tenant. Mark not applicable if the lot is not in a scheme.",
  legalRef: "Residential Tenancies and Rooming Accommodation Act 2008 (Qld); Body Corporate and Community Management Act 1997 (Qld)",
  propertyTypes: ["unit", "townhouse", "other"],
  notApplicableAllowed: true
};

const RETAIL_LESSOR: DisclosureItem = {
  key: "qld_retail_lessor_disclosure",
  label: "Lessor disclosure statement and draft lease",
  description: "For a retail shop lease: the lessor disclosure statement and a copy of the proposed lease, given to the prospective tenant at least 7 days before the lease is entered into. Mark not applicable if the Retail Shop Leases Act does not apply (for example over 1,000 m2).",
  legalRef: "Retail Shop Leases Act 1994 (Qld)",
  propertyTypes: ["retail"],
  notApplicableAllowed: true
};

export interface SeedVersion { jurisdiction: Jurisdiction; transactionType: "sale" | "rent"; useClass: "residential" | "commercial"; items: readonly DisclosureItem[] }

export const SEED_NOTE = "Draft by engineering from public sources on 25 Oct 2026. Compliance and counsel must confirm items, wording and references before approving.";

export const QLD_DRAFT_VERSIONS: readonly SeedVersion[] = [
  {
    jurisdiction: "QLD", transactionType: "sale", useClass: "residential",
    items: [SELLER_DISCLOSURE, TITLE_SEARCH, REGISTERED_PLAN, BODY_CORPORATE_SALE(["unit", "townhouse", "other"]), POOL_SALE, SMOKE_ALARMS_SALE]
  },
  {
    jurisdiction: "QLD", transactionType: "sale", useClass: "commercial",
    items: [SELLER_DISCLOSURE, TITLE_SEARCH, REGISTERED_PLAN, BODY_CORPORATE_SALE(undefined)]
  },
  {
    jurisdiction: "QLD", transactionType: "rent", useClass: "residential",
    items: [SMOKE_ALARMS_RENT, MINIMUM_HOUSING_STANDARDS, POOL_RENT, BY_LAWS_RENT]
  },
  {
    jurisdiction: "QLD", transactionType: "rent", useClass: "commercial",
    items: [RETAIL_LESSOR]
  }
];

/**
 * Code-level fallback for the publish gate when the database requirements are not wired (tests, scripts). Always null: the live
 * requirements are the approved database versions, so nothing here can ever make a combination publishable.
 */
export function getRequiredDisclosureKeys(_j: string, _transactionType: "sale" | "rent", _useClass: string): readonly string[] | null {
  return null;
}
