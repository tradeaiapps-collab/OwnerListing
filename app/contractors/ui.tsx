import type { ReactNode } from "react";
import { formatContractorNo, formatPrice, formatResponse, TRADE_LABELS, type PriceType, type Trade } from "../../src/domain/contractor-market";

export { JSON_HEADERS } from "../listings/ui";
export { Avatar, Stars, initials } from "../marketplace/agents/ui";
export const tradeName = (k: string, label?: string) => (k === "other" && label ? label : TRADE_LABELS[k as Trade] ?? k);
export const price = (cents: number, type: string = "fixed") => formatPrice(cents, type as PriceType);
export const conNo = formatContractorNo;
export const whenAu = (iso: string) => new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

export type Stats = { received: number; accepted: number; rejected: number; completed: number; pending?: number; thisMonth: number; completionRate: number | null; avgResponseMinutes: number | null; ratingAvg: number | null; ratingCount: number };

/** Job figures. The public profile passes aggregates only; the contractor's own dashboard also shows pending jobs. */
export function StatGrid({ s, own }: { s: Stats; own?: boolean }): ReactNode {
  const items: [string, string][] = [
    ["Jobs received", String(s.received)], ["Accepted", String(s.accepted)], ["Rejected", String(s.rejected)], ["Completed", String(s.completed)],
    ["Completion rate", s.completionRate === null ? "None yet" : `${s.completionRate}%`], ["Average response", formatResponse(s.avgResponseMinutes)], ["Jobs this month", String(s.thisMonth)],
    [own ? "Waiting for you" : "Rating", own ? String(s.pending ?? 0) : s.ratingAvg === null ? "No reviews" : `${s.ratingAvg.toFixed(1)} (${s.ratingCount})`]
  ];
  return <ul className="cm-stats" aria-label="Job figures">{items.map(([label, value]) => <li key={label} className="cm-stat"><strong>{value}</strong><span>{label}</span></li>)}</ul>;
}
