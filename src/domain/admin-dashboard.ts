import { staffCan, type StaffActor } from "./staff-access";

/**
 * Admin dashboard headline figures. Counts and sums of what is already stored; no personal data. Each block is included only when the
 * role holds the permission behind it, so one endpoint serves every staff role. The platform holds no money: revenue is paid
 * platform-fee invoices only.
 */

/** Current window and the window before it, so each figure can show its change. */
export interface Windowed { current: number; previous: number }

export interface RawOverview {
  listingsByStatus: { key: string; count: number }[];
  newListings: Windowed;
  offersSubmitted: Windowed;
  offersAccepted: Windowed;
  revenueCents: Windowed;
  usersByType: { key: string; count: number }[];
  newUsers: Windowed;
  suspendedUsers: number;
  openCases: number;
  idPending: number;
}

export interface Kpi { key: string; label: string; value: number; unit: "count" | "cents" | "percent"; previous?: number; hint?: string }

export interface Overview {
  windowDays: number;
  kpis: Kpi[];
  listingsByStatus?: { key: string; count: number }[];
  usersByType?: { key: string; count: number }[];
}

export const OVERVIEW_WINDOW_DAYS = 30;

const safe = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);
const w = (x: Windowed): Windowed => ({ current: safe(x.current), previous: safe(x.previous) });

/** Accepted offers as a share of offers submitted in the same window, in whole percent. Zero offers gives 0, never NaN. */
export function acceptanceRate(accepted: number, submitted: number): number {
  return submitted > 0 ? Math.round((Math.min(accepted, submitted) / submitted) * 100) : 0;
}

/** Signed change from the previous window in whole percent, or null when there is nothing to compare against. */
export function changePercent(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

export function buildOverview(actor: StaffActor, raw: RawOverview): Overview {
  const sales = staffCan(actor, "report.sales");
  const money = staffCan(actor, "report.financial");
  const ops = staffCan(actor, "report.operations");
  const moderate = staffCan(actor, "listing.moderate");
  const users = staffCan(actor, "user.manage");
  const kpis: Kpi[] = [];
  const status = (k: string) => safe(raw.listingsByStatus.find(r => r.key === k)?.count);

  if (sales || moderate) kpis.push({ key: "published", label: "Live listings", value: status("published"), unit: "count" });
  if (moderate) {
    kpis.push({ key: "pending_review", label: "Listings under review", value: status("pending_review"), unit: "count" });
    kpis.push({ key: "suspended", label: "Suspended listings", value: status("suspended"), unit: "count" });
  }
  if (sales) {
    const nl = w(raw.newListings), os = w(raw.offersSubmitted), oa = w(raw.offersAccepted);
    kpis.push({ key: "new_listings", label: "New listings", value: nl.current, previous: nl.previous, unit: "count" });
    kpis.push({ key: "offers", label: "Offers submitted", value: os.current, previous: os.previous, unit: "count" });
    kpis.push({
      key: "acceptance", label: "Offer acceptance", unit: "percent",
      value: acceptanceRate(oa.current, os.current), previous: acceptanceRate(oa.previous, os.previous),
      hint: "Accepted offers as a share of offers submitted in the same period."
    });
  }
  if (money) {
    const r = w(raw.revenueCents);
    kpis.push({ key: "revenue", label: "Platform fees paid", value: r.current, previous: r.previous, unit: "cents", hint: "Paid listing and plan invoices, incl. GST. The platform holds no deposits." });
  }
  if (sales || users) {
    const nu = w(raw.newUsers);
    kpis.push({ key: "new_users", label: "New accounts", value: nu.current, previous: nu.previous, unit: "count" });
  }
  if (users) kpis.push({ key: "suspended_users", label: "Suspended accounts", value: safe(raw.suspendedUsers), unit: "count" });
  if (ops) {
    kpis.push({ key: "open_cases", label: "Open admin cases", value: safe(raw.openCases), unit: "count" });
    kpis.push({ key: "id_pending", label: "ID checks waiting", value: safe(raw.idPending), unit: "count" });
  }

  const out: Overview = { windowDays: OVERVIEW_WINDOW_DAYS, kpis };
  if (sales || moderate) out.listingsByStatus = raw.listingsByStatus.map(r => ({ key: r.key, count: safe(r.count) }));
  if (sales || users) out.usersByType = raw.usersByType.filter(r => r.key !== "admin").map(r => ({ key: r.key, count: safe(r.count) }));
  return out;
}

const aud = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });
const num = new Intl.NumberFormat("en-AU");

export function formatKpi(value: number, unit: Kpi["unit"]): string {
  if (unit === "cents") return aud.format(value / 100);
  if (unit === "percent") return `${value}%`;
  return num.format(value);
}

/** Display labels for stored keys (listing statuses, user types). Unknown keys are shown as stored, with underscores spaced. */
const LABELS: Record<string, string> = {
  draft: "Draft", pending_review: "Under review", published: "Live", withdrawn: "Withdrawn", suspended: "Suspended",
  owner: "Owners", agent: "Agents", buyer: "Buyers", vendor: "Service providers", project_owner: "Project owners", investor: "Investors"
};
export const labelFor = (key: string) => LABELS[key] ?? key.replace(/_/g, " ");
