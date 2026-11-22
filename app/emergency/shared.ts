import { EMERGENCY_TRADES, TRADE_LABELS, type EmergencyTrade } from "../../src/domain/emergency";

export const TRADE_OPTIONS = EMERGENCY_TRADES.map(t => ({ value: t, label: TRADE_LABELS[t] }));
export const tradeLabel = (t: string) => TRADE_LABELS[t as EmergencyTrade] ?? t;
export const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export const dollars = (cents: number | null) => (cents === null ? "price not stated" : `from $${(cents / 100).toLocaleString("en-AU", { maximumFractionDigits: 2 })}`);
export const STATUS_TEXT: Record<string, string> = {
  open: "Waiting for replies", accepted: "Accepted", cancelled: "Cancelled", expired: "No reply in time",
  sent: "Asked", failed: "Could not reach", declined: "Passed", closed: "Someone else took it"
};
export type Window = { days: number[]; start: string; end: string };
