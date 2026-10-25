import { acceptanceRate } from "./admin-dashboard";
import { parseRange, type Range } from "./admin-analytics";
import { toCsv } from "./reports";
import { staffCan, type StaffActor } from "./staff-access";

/**
 * Staff report builder: listings, offers and platform fees for a period, grouped by one dimension. Grouping keys come from a fixed list
 * (never from the request text), so the SQL stays parameterised. Agent names follow the personal-data permissions: full name with
 * pii.view_full, first name and initial with pii.view_masked, otherwise a short reference only. Revenue needs report.financial.
 */

export const DIMENSIONS = [
  { key: "category", label: "Property type" },
  { key: "transaction", label: "Sale or rent" },
  { key: "region", label: "State" },
  { key: "suburb", label: "Suburb" },
  { key: "agent", label: "Agent" }
] as const;
export type Dimension = (typeof DIMENSIONS)[number]["key"];
export const isDimension = (v: unknown): v is Dimension => DIMENSIONS.some(d => d.key === v);

export interface ReportQuery { range: Range; dimension: Dimension }

export function parseReportQuery(p: URLSearchParams, today: string): { ok: true; query: ReportQuery } | { ok: false; error: string } {
  const dim = p.get("dimension") ?? "category";
  if (!isDimension(dim)) return { ok: false, error: "Unknown grouping." };
  // The report is one table, not a chart, so the bucket only matters for range checks; month allows the longest period.
  const q = new URLSearchParams(p);
  q.set("bucket", "month");
  const r = parseRange(q, today);
  return r.ok ? { ok: true, query: { range: r.range, dimension: dim } } : r;
}

/** One group as loaded. `agentName` is only set for the agent dimension and is masked before it leaves the server. */
export interface RawReportRow {
  key: string; agentName?: string | null;
  listingsCreated: number; liveNow: number; offers: number; accepted: number; revenueCents: number;
}

export interface ReportRow { key: string; label: string; listingsCreated: number; liveNow: number; offers: number; accepted: number; acceptance: number; revenueCents?: number }
export interface BuiltReport { query: ReportQuery; dimensionLabel: string; rows: ReportRow[]; totals: Omit<ReportRow, "key" | "label">; revenueIncluded: boolean }

/** "Jane Citizen" -> "Jane C."; a single name stays as its first letter and a dot. */
export function maskName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "Agent";
  if (parts.length === 1) return `${parts[0]![0]}.`;
  return `${parts[0]} ${parts[parts.length - 1]![0]}.`;
}

const NO_AGENT = "none";
const STATE_NAMES: Record<string, string> = {
  NSW: "New South Wales", VIC: "Victoria", QLD: "Queensland", WA: "Western Australia", SA: "South Australia", TAS: "Tasmania", ACT: "ACT", NT: "Northern Territory"
};
const TYPE_NAMES: Record<string, string> = { sale: "Sale", rent: "Rent" };

export function groupLabel(actor: StaffActor, dim: Dimension, row: RawReportRow): string {
  if (row.key === "" || row.key === "unknown") return "Not given";
  if (dim === "region") return STATE_NAMES[row.key] ?? row.key;
  if (dim === "transaction") return TYPE_NAMES[row.key] ?? row.key;
  if (dim === "category") return row.key.charAt(0).toUpperCase() + row.key.slice(1);
  if (dim === "agent") {
    if (row.key === NO_AGENT) return "No agent (owner listed)";
    const ref = `Agent ${row.key.slice(0, 8)}`;
    if (!row.agentName) return ref;
    if (staffCan(actor, "pii.view_full")) return row.agentName;
    if (staffCan(actor, "pii.view_masked")) return maskName(row.agentName);
    return ref;
  }
  return row.key;
}

const safe = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0);

export function buildReport(actor: StaffActor, query: ReportQuery, raw: readonly RawReportRow[]): BuiltReport {
  const revenueIncluded = staffCan(actor, "report.financial");
  const rows: ReportRow[] = raw.map(r => {
    const offers = safe(r.offers), accepted = safe(r.accepted);
    return {
      key: r.key, label: groupLabel(actor, query.dimension, r),
      listingsCreated: safe(r.listingsCreated), liveNow: safe(r.liveNow), offers, accepted, acceptance: acceptanceRate(accepted, offers),
      ...(revenueIncluded ? { revenueCents: safe(r.revenueCents) } : {})
    };
  }).sort((a, b) => b.listingsCreated - a.listingsCreated || b.offers - a.offers || a.label.localeCompare(b.label));
  const add = (k: "listingsCreated" | "liveNow" | "offers" | "accepted" | "revenueCents") => rows.reduce((t, r) => t + (r[k] ?? 0), 0);
  const totals = {
    listingsCreated: add("listingsCreated"), liveNow: add("liveNow"), offers: add("offers"), accepted: add("accepted"),
    acceptance: acceptanceRate(add("accepted"), add("offers")), ...(revenueIncluded ? { revenueCents: add("revenueCents") } : {})
  };
  const dimensionLabel = DIMENSIONS.find(d => d.key === query.dimension)!.label;
  return { query, dimensionLabel, rows, totals, revenueIncluded };
}

const dollars = (c: number | undefined) => ((c ?? 0) / 100).toFixed(2);

export function reportCsv(r: BuiltReport): string {
  const head = [r.dimensionLabel, "Listings created", "Live now", "Offers", "Accepted offers", "Acceptance %", ...(r.revenueIncluded ? ["Platform fees paid incl. GST (AUD)"] : [])];
  const line = (label: string, x: Omit<ReportRow, "key" | "label">) =>
    [label, x.listingsCreated, x.liveNow, x.offers, x.accepted, x.acceptance, ...(r.revenueIncluded ? [dollars(x.revenueCents)] : [])];
  return toCsv(head, [...r.rows.map(x => line(x.label, x)), line("Total", r.totals)]);
}
