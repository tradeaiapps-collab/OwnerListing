import type { DisclosureItem } from "../domain/disclosure-config";
import type { SeedVersion } from "./disclosures";

/**
 * Residential sale disclosure requirements for the other seven states and territories, seeded as DRAFT versions by
 * db/20261106120000_state_disclosure_drafts.sql. Like the Queensland seed they do nothing until a Compliance user other than the
 * author approves them at /staff/disclosures; until then publishing stays blocked (fail closed).
 *
 * Drafted by engineering from public sources on 6 Nov 2026, not legal advice. Section numbers and form names must be confirmed by
 * Australian counsel before approval. Items that are only recommended practice (building and pest inspections in NSW/QLD/SA) are
 * deliberately left out: a requirement here blocks publishing, so only statutory items belong. Keys are stable: never rename one.
 */

const item = (key: string, label: string, description: string, legalRef: string, notApplicableAllowed: boolean, propertyTypes?: DisclosureItem["propertyTypes"]): DisclosureItem =>
  ({ key, label, description, legalRef, ...(propertyTypes ? { propertyTypes } : {}), notApplicableAllowed });

const STRATA_TYPES = ["unit", "townhouse", "other"] as const;
const POOL_TYPES = ["house", "unit", "townhouse", "other"] as const;

export const STATE_SEED_NOTE = "Draft by engineering from public sources on 6 Nov 2026. Compliance and counsel must confirm items, section numbers and wording before approving.";

export const STATE_DRAFT_VERSIONS: readonly SeedVersion[] = [
  {
    jurisdiction: "NSW", transactionType: "sale", useClass: "residential",
    items: [
      item("nsw_planning_certificate", "Section 10.7 planning certificate", "A current planning certificate for the property, showing zoning and the planning controls that apply. It is attached to the contract for sale.", "Environmental Planning and Assessment Act 1979 (NSW), s 10.7; Conveyancing (Sale of Land) Regulation 2022 (NSW), Sch 1", false),
      item("nsw_title_document", "Title documents", "A current title search or the registered title for the property, attached to the contract for sale.", "Conveyancing Act 1919 (NSW), s 52A; Conveyancing (Sale of Land) Regulation 2022 (NSW), Sch 1", false),
      item("nsw_sewer_diagram", "Sewer service diagram", "The Sydney Water (or local water authority) sewer service diagram showing the sewer lines on the property.", "Conveyancing (Sale of Land) Regulation 2022 (NSW), Sch 1", false),
      item("nsw_strata_information", "Strata information certificate", "For a lot in a strata scheme: the strata information certificate (levies, by-laws, insurance, sinking fund and other prescribed details). Mark not applicable if the lot is not in a strata scheme.", "Strata Schemes Management Act 2015 (NSW), s 184; Conveyancing (Sale of Land) Regulation 2022 (NSW), Sch 1", true, STRATA_TYPES),
      item("nsw_pool_compliance", "Swimming pool certificate or exemption", "If there is a swimming pool: a current certificate of compliance or occupation certificate, or the registration details. Mark not applicable if there is no pool.", "Swimming Pools Act 1992 (NSW), Pt 2; Conveyancing (Sale of Land) Regulation 2022 (NSW), Sch 1", true, POOL_TYPES)
    ]
  },
  {
    jurisdiction: "VIC", transactionType: "sale", useClass: "residential",
    items: [
      item("vic_section_32", "Section 32 vendor statement", "The signed vendor statement given to buyers before they sign a contract. It covers title, mortgages and encumbrances, planning controls and overlays (including any heritage overlay), rates and charges, and notices or orders on the property.", "Sale of Land Act 1962 (Vic), s 32", false),
      item("vic_building_permits", "Building permits and occupancy certificate", "Building permits issued in the last 7 years, with the certificate of occupancy or final inspection certificate, and any owner-builder insurance details.", "Sale of Land Act 1962 (Vic), s 32; Building Act 1993 (Vic)", false),
      item("vic_owners_corporation", "Owners corporation certificate", "For a lot in an owners corporation: the current owners corporation certificate (fees, special levies, insurance and rules). Mark not applicable if the lot is not in an owners corporation.", "Owners Corporations Act 2006 (Vic), s 151; Sale of Land Act 1962 (Vic), s 32", true, STRATA_TYPES)
    ]
  },
  {
    jurisdiction: "SA", transactionType: "sale", useClass: "residential",
    items: [
      item("sa_form_1_vendor_statement", "Form 1 vendor's statement", "The vendor's statement (Form 1) given to the buyer before the contract is signed, with the attached council, water and sewerage and other prescribed information.", "Land and Business (Sale and Conveyancing) Act 1994 (SA), s 7", false),
      item("sa_title_search", "Certificate of title search", "A current certificate of title search, attached to the Form 1 vendor's statement.", "Land and Business (Sale and Conveyancing) Act 1994 (SA), s 7", false),
      item("sa_community_title", "Community or strata title information", "For a lot in a community or strata scheme: the by-laws, levies and insurance details required with the Form 1 statement. Mark not applicable if the lot is not in a scheme.", "Land and Business (Sale and Conveyancing) Act 1994 (SA), s 7; Community Titles Act 1996 (SA)", true, STRATA_TYPES)
    ]
  },
  {
    jurisdiction: "WA", transactionType: "sale", useClass: "residential",
    items: [
      item("wa_title_search", "Certificate of title search", "A current certificate of title search showing the registered owner, easements, caveats and other interests.", "Transfer of Land Act 1893 (WA)", false),
      item("wa_strata_information", "Strata information for the buyer", "For a strata lot: the information a seller must give a buyer before the contract (levies, by-laws, insurance and the scheme's financial position). Mark not applicable if the lot is not in a strata scheme.", "Strata Titles Act 1985 (WA), seller's information to a buyer", true, STRATA_TYPES)
    ]
  },
  {
    jurisdiction: "TAS", transactionType: "sale", useClass: "residential",
    items: [
      item("tas_vendor_disclosure", "Vendor disclosure statement", "The vendor's disclosure of title details, easements and covenants, planning and building matters, rates and any notices affecting the property, given to the buyer before they are bound.", "Land Titles Act 1980 (Tas), s 35", false),
      item("tas_title_documents", "Title folio and plan", "A current copy of the folio of the Register and the title plan for the property.", "Land Titles Act 1980 (Tas)", false)
    ]
  },
  {
    jurisdiction: "ACT", transactionType: "sale", useClass: "residential",
    items: [
      item("act_sale_disclosure", "Contract disclosure statement", "The statement of prescribed information (title, lease, rates, encumbrances and notices) that must accompany the contract for sale of residential property in the ACT.", "Civil Law (Sale of Residential Property) Act 2003 (ACT)", false),
      item("act_building_report", "Building inspection report", "A building inspection report for the property, provided with the contract.", "Civil Law (Sale of Residential Property) Act 2003 (ACT)", false),
      item("act_pest_report", "Pest inspection report", "A pest inspection report for the property, provided with the contract.", "Civil Law (Sale of Residential Property) Act 2003 (ACT)", false),
      item("act_energy_rating", "Energy efficiency rating statement", "The energy efficiency rating statement for the dwelling, disclosed in advertising and the contract.", "Civil Law (Sale of Residential Property) Act 2003 (ACT); Energy Efficiency Rating legislation (ACT)", false, ["house", "unit", "townhouse"]),
      item("act_unit_title_certificate", "Unit title certificate", "For a unit: the unit title certificate (levies, rules, sinking fund and insurance). Mark not applicable if the property is not a unit.", "Unit Titles (Management) Act 2011 (ACT)", true, STRATA_TYPES)
    ]
  },
  {
    jurisdiction: "NT", transactionType: "sale", useClass: "residential",
    items: [
      item("nt_vendor_disclosure", "Vendor disclosure statement", "The vendor's statement of title, encumbrances, planning, rates and other prescribed matters, given to the buyer before the contract is signed.", "Law of Property Act 2000 (NT), vendor disclosure requirements", false),
      item("nt_title_search", "Title search", "A current title search for the property.", "Land Title Act 2000 (NT)", false),
      item("nt_unit_title", "Unit title information", "For a unit: the body corporate statement of levies, rules and insurance. Mark not applicable if the property is not a unit.", "Unit Titles Act 1975 (NT)", true, STRATA_TYPES)
    ]
  }
];
