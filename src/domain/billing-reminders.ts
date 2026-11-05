import { addDays, type Invoice } from "./billing";

export type ReminderStage = "upcoming" | "due" | "overdue" | "final";
export const REMINDER_STAGES: readonly ReminderStage[] = ["upcoming", "due", "overdue", "final"];

/** Days relative to the due date at which each stage starts. */
const START_DAY: Record<ReminderStage, number> = { upcoming: -3, due: 0, overdue: 3, final: 10 };

export const isOverdue = (i: Pick<Invoice, "status" | "dueAt">, now: string): boolean => i.status === "pending" && !!i.dueAt && i.dueAt < now;

/** Whole days past the due date, zero when not overdue. */
export const daysOverdue = (i: Pick<Invoice, "status" | "dueAt">, now: string): number =>
  isOverdue(i, now) ? Math.floor((Date.parse(now) - Date.parse(i.dueAt as string)) / 86_400_000) : 0;

/**
 * The one reminder to send now for an unpaid invoice, or null. Only the latest stage reached is sent, and never a stage already sent,
 * so a customer who was not reminded for a while does not get a burst of emails.
 */
export function reminderToSend(i: Pick<Invoice, "status" | "dueAt">, now: string, sent: ReadonlySet<ReminderStage>): ReminderStage | null {
  if (i.status !== "pending" || !i.dueAt) return null;
  let reached: ReminderStage | null = null;
  for (const s of REMINDER_STAGES) if (now >= addDays(i.dueAt, START_DAY[s])) reached = s;
  return reached && !sent.has(reached) ? reached : null;
}

export interface ReminderEmail { subject: string; text: string }

const aud = (cents: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(cents / 100);

/** Plain text only. Never includes card data, bank details or links that ask for them; the customer signs in to pay. */
export function reminderEmail(stage: ReminderStage, i: Pick<Invoice, "invoiceNumber" | "totalCents" | "dueAt">, siteName: string, billingUrl: string): ReminderEmail {
  const ref = i.invoiceNumber ?? "your invoice";
  const due = i.dueAt ? new Date(i.dueAt).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "Australia/Brisbane" }) : "";
  const lead: Record<ReminderStage, string> = {
    upcoming: `Invoice ${ref} for ${aud(i.totalCents)} is due on ${due}.`,
    due: `Invoice ${ref} for ${aud(i.totalCents)} is due today.`,
    overdue: `Invoice ${ref} for ${aud(i.totalCents)} was due on ${due} and is now overdue.`,
    final: `Final reminder: invoice ${ref} for ${aud(i.totalCents)} was due on ${due} and is still unpaid.`
  };
  const subject: Record<ReminderStage, string> = {
    upcoming: `Invoice ${ref} is due soon`, due: `Invoice ${ref} is due today`,
    overdue: `Invoice ${ref} is overdue`, final: `Final reminder: invoice ${ref}`
  };
  return {
    subject: `${siteName}: ${subject[stage]}`,
    text: `${lead[stage]}\n\nSign in to pay, see the invoice, or tell us if something looks wrong:\n${billingUrl}\n\n` +
      `We will never ask you for card numbers or passwords by email. If you have already paid, thank you; it can take a short time to show.\n`
  };
}
