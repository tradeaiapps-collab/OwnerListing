import type { Invoice } from "../../src/domain/billing";

export const money = (cents: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(cents / 100);
export const dateAu = (iso: string) => new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "Australia/Brisbane" });

/** Label and colour class for an invoice's state. Overdue is a pending invoice past its due date. */
export function invoiceState(i: Pick<Invoice, "status" | "dueAt">, now = Date.now()): { label: string; tone: "good" | "warn" | "bad" | "" } {
  if (i.status === "paid") return { label: "Paid", tone: "good" };
  if (i.status === "pending") return i.dueAt && Date.parse(i.dueAt) < now ? { label: "Overdue", tone: "bad" } : { label: "Unpaid", tone: "warn" };
  if (i.status === "failed") return { label: "Payment failed", tone: "bad" };
  if (i.status === "refunded") return { label: "Refunded", tone: "" };
  return { label: "Cancelled", tone: "" };
}

export const KIND_LABEL: Record<string, string> = { listing_fee: "Listing fee", subscription: "Plan", other: "Fee" };
export const METHOD_LABEL: Record<string, string> = { card: "Card", bank_transfer: "Bank transfer" };
