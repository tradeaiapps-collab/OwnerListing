import type { Jurisdiction } from "./jurisdiction";
import { hasVerifiedLicence, type AgentLicence } from "./licence";
import type { TrustAccountDecision } from "./trust-account";

/**
 * The public "compliance and safety" facts of a listing, shown on the property page.
 * Built from staff-verified records only. No user ids, names, licence numbers or bank details leave here.
 */

/** Raw facts read by the server (src/server/listing-compliance-db.ts). */
export interface ComplianceFacts {
  jurisdiction: Jurisdiction;
  createdAt: string;
  /** The appointed agent's licences in any state (verified rows only), or undefined when no agent is appointed. */
  agent?: { userId: string; appointedAt: string; licences: readonly AgentLicence[] };
  trust?: TrustAccountDecision;
  /** Firm name of the trust account behind the latest approved check. */
  firmName?: string;
  disclosures: readonly { key: string; satisfied: boolean; verifiedAt?: string }[];
  /** Keys compliance requires for this state and listing kind, or null while not configured. */
  required: readonly string[] | null;
}

export type DepositStatus = "verified" | "checking" | "not_set";

export interface DisclosureItem { key: string; label: string; satisfied: boolean; verifiedAt?: string; required: boolean }

export interface ComplianceView {
  seller: { handledBy: "owner" | "agent"; agentLicenceVerified: boolean; agentState?: Jurisdiction };
  deposit: { status: DepositStatus; firmName?: string };
  disclosures: DisclosureItem[];
  /** False while compliance has not configured required disclosures for this state and listing kind. */
  requirementsConfigured: boolean;
  /** Required items not yet provided (empty when not configured). */
  outstanding: number;
  listedAt: string;
}

/**
 * Plain names for known disclosure keys. The keys come from compliance configuration; anything unknown is
 * shown humanised rather than guessed. These are labels only, not legal advice on what a state requires.
 */
const LABELS: Readonly<Record<string, string>> = {
  qld_seller_disclosure_statement: "Seller disclosure statement (QLD)",
  vic_section_32: "Vendor's statement, section 32 (VIC)",
  nsw_contract_of_sale: "Contract of sale (NSW)",
  pool_safety_certificate: "Pool safety certificate",
  smoke_alarm_compliance: "Smoke alarm compliance",
  building_pest_report: "Building and pest report",
  strata_report: "Strata or body corporate report",
  title_search: "Title search",
  energy_rating: "Energy rating"
};

export function disclosureLabel(key: string): string {
  const known = LABELS[key];
  if (known) return known;
  const words = key.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Disclosure";
}

function depositOf(trust: TrustAccountDecision | undefined, firmName: string | undefined): ComplianceView["deposit"] {
  if (!trust) return { status: "not_set" };
  if (trust.kind === "approved") return firmName ? { status: "verified", firmName } : { status: "verified" };
  // Every other decision is still with a person or needs evidence; the reasons are internal.
  return { status: "checking" };
}

/** Pure: turns the facts into what the page shows. `today` is YYYY-MM-DD so licence expiry is deterministic. */
export function toComplianceView(f: ComplianceFacts, today: string): ComplianceView {
  const agent = f.agent;
  const seller: ComplianceView["seller"] = agent
    ? { handledBy: "agent", agentLicenceVerified: hasVerifiedLicence(agent.licences, agent.userId, f.jurisdiction, today), agentState: f.jurisdiction }
    : { handledBy: "owner", agentLicenceVerified: false };
  const required = new Set(f.required ?? []);
  const byKey = new Map(f.disclosures.map(d => [d.key, d]));
  const keys = [...required, ...f.disclosures.map(d => d.key).filter(k => !required.has(k))];
  const disclosures = keys.map((key): DisclosureItem => {
    const d = byKey.get(key);
    const item: DisclosureItem = { key, label: disclosureLabel(key), satisfied: d?.satisfied ?? false, required: required.has(key) };
    if (d?.satisfied && d.verifiedAt) item.verifiedAt = d.verifiedAt;
    return item;
  });
  // Provided first, then the rest; stable within each group.
  disclosures.sort((a, b) => Number(b.satisfied) - Number(a.satisfied));
  return {
    seller,
    deposit: depositOf(f.trust, f.firmName),
    disclosures,
    requirementsConfigured: f.required !== null,
    outstanding: disclosures.filter(d => d.required && !d.satisfied).length,
    listedAt: f.createdAt
  };
}

/** Short reference shown to buyers so they can quote the listing (first 8 characters of its id, upper case). */
export function listingReference(id: string): string {
  return id.replace(/-/g, "").slice(0, 8).toUpperCase();
}
