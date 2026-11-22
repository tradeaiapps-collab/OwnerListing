import type { DisclosureItem } from "../domain/disclosure-config";
import type { SeedVersion } from "./disclosures";

/**
 * Rent (residential and commercial) and commercial sale disclosure requirements for NSW, VIC, SA, WA, TAS, ACT and NT, seeded as DRAFT
 * versions by db/20261118090000_state_rent_commercial_disclosure_drafts.sql. Same rules as the other seeds: nothing is required, and
 * nothing publishes in these combinations, until a Compliance user other than the author approves each one at /staff/disclosures.
 *
 * Drafted by engineering from public sources on 18 Nov 2026, not legal advice. Act names are given at Act level on purpose: counsel
 * must confirm section numbers, form names and wording before approval. Only statutory items are listed, because a requirement blocks
 * publishing. Keys are stable: never rename one.
 */

type St = "NSW" | "VIC" | "SA" | "WA" | "TAS" | "ACT" | "NT";

const item = (key: string, label: string, description: string, legalRef: string, notApplicableAllowed: boolean, propertyTypes?: DisclosureItem["propertyTypes"]): DisclosureItem =>
  ({ key, label, description, legalRef, ...(propertyTypes ? { propertyTypes } : {}), notApplicableAllowed });

const SCHEME_TYPES = ["unit", "townhouse", "other"] as const;

export const STATE_MORE_SEED_NOTE = "Draft by engineering from public sources on 18 Nov 2026. Compliance and counsel must confirm items, section numbers and wording before approving.";

const TENANCY_ACT: Record<St, string> = {
  NSW: "Residential Tenancies Act 2010 (NSW)",
  VIC: "Residential Tenancies Act 1997 (Vic)",
  SA: "Residential Tenancies Act 1995 (SA)",
  WA: "Residential Tenancies Act 1987 (WA)",
  TAS: "Residential Tenancy Act 1997 (Tas)",
  ACT: "Residential Tenancies Act 1997 (ACT)",
  NT: "Residential Tenancies Act 1999 (NT)"
};

const RETAIL_ACT: Record<St, string> = {
  NSW: "Retail Leases Act 1994 (NSW)",
  VIC: "Retail Leases Act 2003 (Vic)",
  SA: "Retail and Commercial Leases Act 1995 (SA)",
  WA: "Commercial Tenancy (Retail Shops) Agreements Act 1985 (WA)",
  TAS: "Fair Trading (Code of Practice for Retail Tenancies) Regulations 1998 (Tas)",
  ACT: "Leases (Commercial and Retail) Act 2001 (ACT)",
  NT: "Business Tenancies (Fair Dealings) Act 2003 (NT)"
};

const SALE_ACT: Record<St, string> = {
  NSW: "Conveyancing (Sale of Land) Regulation 2022 (NSW), Sch 1",
  VIC: "Sale of Land Act 1962 (Vic), s 32",
  SA: "Land and Business (Sale and Conveyancing) Act 1994 (SA)",
  WA: "Transfer of Land Act 1893 (WA)",
  TAS: "Land Titles Act 1980 (Tas)",
  ACT: "Land Titles Act 1925 (ACT)",
  NT: "Law of Property Act 2000 (NT)"
};

const SCHEME_ACT: Record<St, string> = {
  NSW: "Strata Schemes Management Act 2015 (NSW)",
  VIC: "Owners Corporations Act 2006 (Vic)",
  SA: "Community Titles Act 1996 (SA)",
  WA: "Strata Titles Act 1985 (WA)",
  TAS: "Strata Titles Act 1998 (Tas)",
  ACT: "Unit Titles (Management) Act 2011 (ACT)",
  NT: "Unit Titles Act 1975 (NT)"
};

const residentialRent = (s: St): readonly DisclosureItem[] => {
  const k = s.toLowerCase();
  return [
    item(`${k}_rent_agreement`, "Written tenancy agreement", "The written residential tenancy agreement in the form the state requires, given to the tenant, with the prescribed information statement where one applies.", TENANCY_ACT[s], false),
    item(`${k}_rent_condition_report`, "Condition report", "A condition report on the property at the start of the tenancy, given to the tenant to check and return.", TENANCY_ACT[s], false),
    item(`${k}_rent_bond`, "Bond lodgement", "The rental bond is lodged with the state's rental bond authority, not held by the owner. Provide the lodgement receipt or number once the bond is paid.", TENANCY_ACT[s], false),
    item(`${k}_rent_smoke_alarms`, "Smoke alarm compliance", "Evidence that smoke alarms are installed and working as the state requires for rental properties.", `${TENANCY_ACT[s]}; state smoke alarm requirements`, false)
  ];
};

const commercialSale = (s: St): readonly DisclosureItem[] => {
  const k = s.toLowerCase();
  return [
    item(`${k}_comm_sale_vendor_disclosure`, "Vendor disclosure for commercial land", "The vendor's disclosure of title, encumbrances, zoning and planning controls, rates and charges, and notices or orders affecting the property, given to the buyer before the contract is signed.", SALE_ACT[s], false),
    item(`${k}_comm_sale_title_search`, "Current title search", "A current title search for the property, showing the registered owner, easements, covenants and other interests.", SALE_ACT[s], false),
    item(`${k}_comm_sale_scheme`, "Strata or scheme information", "For a lot in a strata, owners corporation or community scheme: the levies, by-laws, insurance and financial position of the scheme. Mark not applicable if the lot is not in a scheme.", SCHEME_ACT[s], true, SCHEME_TYPES)
  ];
};

const commercialRent = (s: St): readonly DisclosureItem[] => [
  item(`${s.toLowerCase()}_comm_rent_retail_lease`, "Retail lease disclosure statement and draft lease", "For a retail shop lease: the lessor's disclosure statement and a copy of the proposed lease, given to the prospective tenant before the lease is entered into. Mark not applicable if the retail lease law does not apply (for example the premises or tenant are outside its scope).", RETAIL_ACT[s], true, ["retail"])
];

const STATES: readonly St[] = ["NSW", "VIC", "SA", "WA", "TAS", "ACT", "NT"];

export const STATE_MORE_DRAFT_VERSIONS: readonly SeedVersion[] = STATES.flatMap((s): SeedVersion[] => [
  { jurisdiction: s, transactionType: "sale", useClass: "commercial", items: commercialSale(s) },
  { jurisdiction: s, transactionType: "rent", useClass: "residential", items: residentialRent(s) },
  { jurisdiction: s, transactionType: "rent", useClass: "commercial", items: commercialRent(s) }
]);
