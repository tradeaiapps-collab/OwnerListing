import { staffCan, type StaffActor } from "./staff-access";

/** Reports only count and add up what is already stored. The platform holds no money: revenue is paid platform-fee invoices only. */

export const LISTING_STATUSES = ["draft", "pending_review", "published", "suspended", "withdrawn"] as const;
export const TRUST_DECISIONS = ["approved", "awaiting_human_approval", "needs_more_evidence", "flagged_for_admin", "rejected"] as const;
export const ID_STATUSES = ["pending", "approved", "rejected", "needs_more"] as const;

export interface Counted { key: string; count: number }
export interface RawStaffReport {
  listingsByStatus: Counted[];
  paidInvoices: { count: number; totalCents: number; gstCents: number; last30DaysCents: number };
  openCases: { kind: string; status: string; count: number }[];
  buyers: { accounts: number; emailVerified: number; phoneVerified: number; idVerified: number };
  idSubmissions: Counted[];
  trustChecks: Counted[];
}

export interface StaffReport {
  listings?: { status: string; count: number }[];
  revenue?: { paidInvoices: number; totalCents: number; gstCents: number; exGstCents: number; last30DaysCents: number };
  openCases?: { total: number; byKind: { kind: string; count: number }[] };
  verificationFunnel?: {
    buyers: { step: string; count: number }[];
    idSubmissions: { status: string; count: number }[];
    trustAccountChecks: { decision: string; count: number }[];
  };
}

const safeInt = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0);

/** Every known status appears (zero when none); unknown values are kept so nothing is silently dropped. */
export function countByKeys(rows: readonly Counted[], known: readonly string[]): Counted[] {
  const map = new Map<string, number>(known.map(k => [k, 0]));
  for (const r of rows) map.set(r.key, (map.get(r.key) ?? 0) + safeInt(r.count));
  return [...map].map(([key, count]) => ({ key, count }));
}

/** Sections a staff member may see: sales for listings, financial for revenue, operations for cases and the funnel. */
export function reportSectionsFor(actor: StaffActor) {
  return { listings: staffCan(actor, "report.sales"), revenue: staffCan(actor, "report.financial"), operations: staffCan(actor, "report.operations") };
}

export function buildStaffReport(actor: StaffActor, raw: RawStaffReport): StaffReport {
  const allowed = reportSectionsFor(actor);
  const out: StaffReport = {};
  if (allowed.listings) out.listings = countByKeys(raw.listingsByStatus, LISTING_STATUSES).map(r => ({ status: r.key, count: r.count }));
  if (allowed.revenue) {
    const totalCents = safeInt(raw.paidInvoices.totalCents), gstCents = safeInt(raw.paidInvoices.gstCents);
    out.revenue = { paidInvoices: safeInt(raw.paidInvoices.count), totalCents, gstCents, exGstCents: Math.max(0, totalCents - gstCents), last30DaysCents: safeInt(raw.paidInvoices.last30DaysCents) };
  }
  if (allowed.operations) {
    const byKind = new Map<string, number>();
    for (const c of raw.openCases) if (c.status !== "resolved") byKind.set(c.kind, (byKind.get(c.kind) ?? 0) + safeInt(c.count));
    out.openCases = { total: [...byKind.values()].reduce((a, b) => a + b, 0), byKind: [...byKind].map(([kind, count]) => ({ kind, count })) };
    out.verificationFunnel = {
      buyers: [
        { step: "Accounts", count: safeInt(raw.buyers.accounts) }, { step: "Email verified", count: safeInt(raw.buyers.emailVerified) },
        { step: "Phone verified", count: safeInt(raw.buyers.phoneVerified) }, { step: "ID verified", count: safeInt(raw.buyers.idVerified) }
      ],
      idSubmissions: countByKeys(raw.idSubmissions, ID_STATUSES).map(r => ({ status: r.key, count: r.count })),
      trustAccountChecks: countByKeys(raw.trustChecks, TRUST_DECISIONS).map(r => ({ decision: r.key, count: r.count }))
    };
  }
  return out;
}

export type CsvCell = string | number | null | undefined;

/** A spreadsheet runs a cell starting with = + - @ (or tab / CR) as a formula, so it is prefixed with an apostrophe. */
export function neutraliseCell(v: CsvCell): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}
const quote = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function toCsv(header: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  return [header, ...rows].map(r => r.map(c => quote(neutraliseCell(c))).join(",")).join("\r\n") + "\r\n";
}

const dollars = (cents: number) => (cents / 100).toFixed(2);

export function staffReportRows(r: StaffReport): [string, string, number | string][] {
  const rows: [string, string, number | string][] = [];
  const REV = "Revenue (paid invoices, AUD)";
  r.listings?.forEach(l => rows.push(["Listings by status", l.status, l.count]));
  if (r.revenue) {
    rows.push([REV, "Paid invoices", r.revenue.paidInvoices], [REV, "Total incl. GST", dollars(r.revenue.totalCents)], [REV, "GST", dollars(r.revenue.gstCents)],
      [REV, "Total excl. GST", dollars(r.revenue.exGstCents)], [REV, "Paid in last 30 days incl. GST", dollars(r.revenue.last30DaysCents)]);
  }
  if (r.openCases) {
    rows.push(["Open cases", "Total", r.openCases.total]);
    r.openCases.byKind.forEach(k => rows.push(["Open cases", k.kind, k.count]));
  }
  r.verificationFunnel?.buyers.forEach(b => rows.push(["Buyer verification", b.step, b.count]));
  r.verificationFunnel?.idSubmissions.forEach(s => rows.push(["ID submissions", s.status, s.count]));
  r.verificationFunnel?.trustAccountChecks.forEach(t => rows.push(["Trust account checks (latest per job)", t.decision, t.count]));
  return rows;
}
export const staffReportCsv = (r: StaffReport) => toCsv(["Section", "Metric", "Value"], staffReportRows(r));

/** Owner view: only the owner's own listings. Page views are not tracked, so enquiries and offers are counted instead. */
export interface OwnerListingRow { id: string; title: string; status: string; enquiries: number; offers: number }
export interface OwnerReport { viewsTracked: false; listings: OwnerListingRow[]; totals: { enquiries: number; offers: number } }

export function buildOwnerReport(rows: readonly OwnerListingRow[]): OwnerReport {
  const listings = rows.map(r => ({ ...r, enquiries: safeInt(r.enquiries), offers: safeInt(r.offers) }));
  return { viewsTracked: false, listings, totals: { enquiries: listings.reduce((s, l) => s + l.enquiries, 0), offers: listings.reduce((s, l) => s + l.offers, 0) } };
}
export const ownerReportCsv = (r: OwnerReport) =>
  toCsv(["Listing", "Status", "Enquiries", "Offers"], r.listings.map(l => [l.title, l.status, l.enquiries, l.offers]));
