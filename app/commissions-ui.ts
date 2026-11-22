import type { CommissionDeal, CommissionTerms } from "../src/domain/commission";

export const money = (cents: number) => `$${(cents / 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-AU", { month: "short", year: "numeric", timeZone: "UTC" });
export const dateLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
/** Dollars typed by a person to whole cents; NaN when it is not a non-negative amount. */
export const toCents = (v: string) => { const n = Number(v.replace(/[$,\s]/g, "")); return v.trim() !== "" && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : Number.NaN; };

export function termsLabel(t: CommissionTerms): string {
  if (t.kind === "percentage") return `${(t.bps / 100).toFixed(2)}% of price`;
  if (t.kind === "fixed") return `Fixed ${money(t.fixedCents)}`;
  return `Tiered, ${t.tiers.length} bands`;
}
export const STATUS_LABEL: Record<CommissionDeal["status"], string> = { expected: "Expected", earned: "Earned", cancelled: "Cancelled" };
