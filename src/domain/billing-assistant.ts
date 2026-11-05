import { isOverdue, daysOverdue } from "./billing-reminders";
import type { InvoiceKind, PaymentMethod } from "./billing";
import { GST_RATE_PERCENT } from "./billing";

/**
 * Elena's billing help, for a signed-in owner or agent, on their Billing page. Rule based and deterministic, built only from the
 * person's own invoices and subscription, so it cannot reveal anyone else's data. She explains, troubleshoots and points to the right
 * button. She never takes a payment, confirms one that the provider has not confirmed, promises a refund, or decides a dispute (staff
 * do). She does not give tax or accounting advice. The typed question is used to pick an answer and is not stored.
 */
export const BILLING_TOPICS = [
  "greeting", "gst", "how_to_pay", "bank_transfer", "failed_payment", "overdue", "invoice_copy", "subscription", "cancel",
  "dispute", "refund", "upgrade", "advice", "privacy", "unknown"
] as const;
export type BillingTopic = (typeof BILLING_TOPICS)[number];

export interface InvoiceFact {
  number: string; kind: InvoiceKind; totalCents: number; status: "pending" | "paid" | "failed" | "void" | "refunded";
  dueAt?: string; paymentMethod?: PaymentMethod; disputeOpen: boolean;
}
export interface BillingFacts {
  userType: "owner" | "agent" | string;
  invoices: InvoiceFact[];
  subscription?: { planName: string; status: string; interval: "monthly" | "yearly"; endsAt: string; cancelAtPeriodEnd: boolean };
  cardAvailable: boolean;
  bankTransferAvailable: boolean;
  /** Listing fees this person paid in the last 90 days, and what they came to excluding GST. */
  recentListingFees: { count: number; exGstCents: number };
  /** Cheapest priced subscription plan for this person's account type, monthly excl. GST, if any is priced. */
  suggestedPlan?: { name: string; monthlyExGstCents: number };
  now: string;
}

export interface BillingLink { label: string; href: string }
export interface BillingAnswer { topic: BillingTopic; text: string; links: BillingLink[]; suggestions: string[]; disclaimer: string }

export const BILLING_QUESTION_MAX = 300;
export const BILLING_DISCLAIMER = "General help with your invoices on this website. Not tax, legal or accounting advice. Payments are confirmed by the bank's payment provider, not by me.";

const RULES: [BillingTopic, RegExp][] = [
  ["advice", /\b(tax return|tax deduct\w*|deduct\w*|write.?off|accountant|ato|bas|claim (back|the) gst|financial advice|legal advice)\b/i],
  ["privacy", /\b(someone else|another (user|owner|agent)|their (invoice|bill|payment)|other people)\b/i],
  ["dispute", /\b(dispute|chargeback|charged twice|double.?charged|wrong (amount|charge)|overcharged|didn'?t (agree|authori[sz]e)|unauthori[sz]ed|incorrect invoice|not mine|wrong|incorrect|mistake)\b/i],
  ["refund", /\b(refund|money back|reimburse|cancel (my )?(payment|invoice)|get my money)\b/i],
  ["failed_payment", /\b(fail(ed|s|ing)?|declin(ed|e)|didn'?t (go through|work|process)|not (working|going through)|payment (error|problem|issue)|can'?t pay|couldn'?t pay|still (unpaid|pending)|trouble|stuck|error)\b/i],
  ["bank_transfer", /\b(bank transfer|direct (deposit|debit)|bsb|eft|account number|pay by bank|wire)\b/i],
  ["overdue", /\b(overdue|late|reminder|past due|owe|outstanding|how much do i)\b/i],
  ["cancel", /\b(cancel|stop (my )?(plan|subscription|renewal)|unsubscribe|end my (plan|subscription))\b/i],
  ["upgrade", /\b(upgrade|cheaper|save money|better (plan|deal)|which plan|best plan|discount|worth it)\b/i],
  ["subscription", /\b(subscription|renew(al|s)?|monthly|yearly|annual|my plan|billing (cycle|period)|recurring|next payment)\b/i],
  ["invoice_copy", /\b(receipt|tax invoice|copy of|download|abn|invoice (number|copy)|proof of payment)\b/i],
  ["gst", /\b(gst|goods and services|tax included|excl|incl(uding|usive)?|why (is|are) .*(more|extra))\b/i],
  ["how_to_pay", /\b(how (do|can|to) (i )?pay|pay (my|the) (invoice|bill)|payment (method|options?)|credit card|visa|mastercard|card)\b/i],
  ["greeting", /^\s*(hi|hello|hey|g'?day|help|billing|start)\b/i]
];

export function matchBillingTopic(text: unknown): BillingTopic {
  if (typeof text !== "string" || !text.trim()) return "unknown";
  const t = text.slice(0, BILLING_QUESTION_MAX);
  return RULES.find(([, re]) => re.test(t))?.[0] ?? "unknown";
}

const aud = (cents: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(cents / 100);
const day = (iso: string) => new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "Australia/Brisbane" });
const BILLING = { label: "Open Billing", href: "/billing" };
const PLANS = { label: "See plans", href: "/plans" };

const CHIPS: Record<string, string> = {
  how_to_pay: "How do I pay an invoice?", gst: "What is GST on my invoice?", failed_payment: "My payment failed",
  bank_transfer: "Can I pay by bank transfer?", subscription: "How does my subscription renew?", cancel: "How do I cancel my plan?",
  dispute: "I think an invoice is wrong", upgrade: "Is there a cheaper way to list?", invoice_copy: "Where is my tax invoice?"
};
const chips = (...topics: string[]): string[] => topics.map(t => CHIPS[t]).filter((c): c is string => !!c);

export function answerBilling(topic: BillingTopic, f: BillingFacts): BillingAnswer {
  const unpaid = f.invoices.filter(i => i.status === "pending");
  const failed = f.invoices.filter(i => i.status === "failed");
  const overdue = unpaid.filter(i => isOverdue({ status: i.status, ...(i.dueAt ? { dueAt: i.dueAt } : {}) }, f.now));
  const make = (text: string, links: BillingLink[] = [BILLING], suggestions: string[] = []): BillingAnswer =>
    ({ topic, text, links, suggestions, disclaimer: BILLING_DISCLAIMER });

  switch (topic) {
    case "greeting":
      return make("Hi, I'm Elena. I can explain your invoices and GST, help when a payment doesn't go through, show how your plan renews, and point you to the right button. I can't take payments or decide disputes, but I can tell you how to raise one.",
        [BILLING], chips("how_to_pay", "gst", "failed_payment", "subscription"));
    case "gst":
      return make(`Every fee shows the price excluding GST, then GST at ${GST_RATE_PERCENT}%, then the total you pay. For example a $100.00 fee plus $10.00 GST is a $110.00 total. Your tax invoice shows all three lines and the invoice number.`,
        [BILLING], chips("invoice_copy", "how_to_pay"));
    case "how_to_pay":
      return make([
        f.cardAvailable ? "Open the invoice on your Billing page and press Pay by card. You pay on the bank's secure page, so your card number never touches this website." : "Card payments are not switched on yet, so pay by bank transfer for now.",
        f.bankTransferAvailable ? "You can also pay by bank transfer using the details and reference shown on the invoice; staff match it to the invoice, which can take a business day or so." : ""
      ].filter(Boolean).join(" "), [BILLING], chips("bank_transfer", "failed_payment"));
    case "bank_transfer":
      return make(f.bankTransferAvailable
        ? "Pay the exact total shown on the invoice into the bank account shown on it, and use the invoice number as your payment reference so staff can match it. The invoice stays unpaid until staff confirm the money arrived; it usually takes a business day."
        : "Bank transfer details have not been set up yet. Card payment is the way to pay for now, or contact support.",
        [BILLING], chips("failed_payment", "invoice_copy"));
    case "failed_payment": {
      const pendingFailed = failed.length > 0;
      const lines = [
        pendingFailed ? `I can see ${failed.length} invoice${failed.length === 1 ? "" : "s"} where the payment failed (${failed.slice(0, 3).map(i => i.number).join(", ")}).` : unpaid.length > 0 ? `I can see ${unpaid.length} unpaid invoice${unpaid.length === 1 ? "" : "s"}.` : "I can't see any failed or unpaid invoices on your account.",
        "A card payment can fail if the bank declines it, the card has expired or lacks funds, or the bank asked for an extra check that wasn't completed. Try again on the Billing page, try another card, or pay by bank transfer.",
        "An invoice only shows as paid once the payment provider confirms it. If your bank shows a charge but the invoice is still unpaid, don't pay again: raise a payment issue on the invoice and staff will look into it."
      ];
      return make(lines.join(" "), [BILLING], chips("bank_transfer", "dispute"));
    }
    case "overdue": {
      if (unpaid.length === 0) return make("You have no unpaid invoices. Nothing is due.", [BILLING], chips("subscription", "invoice_copy"));
      const total = unpaid.reduce((a, i) => a + i.totalCents, 0);
      const od = overdue.length > 0 ? ` ${overdue.length} ${overdue.length === 1 ? "is" : "are"} overdue; the oldest by ${Math.max(...overdue.map(i => daysOverdue({ status: i.status, ...(i.dueAt ? { dueAt: i.dueAt } : {}) }, f.now)))} day(s).` : " None are overdue yet.";
      return make(`You have ${unpaid.length} unpaid invoice${unpaid.length === 1 ? "" : "s"} totalling ${aud(total)}.${od} We email a reminder 3 days before the due date, on the day, and again when it is late.`, [BILLING], chips("how_to_pay", "bank_transfer"));
    }
    case "invoice_copy":
      return make("Every invoice on your Billing page has a printable tax invoice with the invoice number, GST and total. Open it and use Print or save as PDF. Paid invoices show the date paid, which works as your receipt.", [BILLING], chips("gst"));
    case "subscription": {
      const s = f.subscription;
      if (!s) return make("You don't have a plan subscription. You pay a flat fee for each listing instead. Plans are billed monthly or yearly and give more photos, storage and AI tools.", [PLANS, BILLING], chips("upgrade"));
      const end = day(s.endsAt);
      return make(s.cancelAtPeriodEnd
        ? `Your ${s.planName} plan is set to end on ${end} and won't renew. You keep its features until then.`
        : `Your ${s.planName} plan (${s.interval}) ${s.status === "past_due" ? "is past due: pay the open invoice to keep it" : `is paid until ${end}`}. About a week before it ends we issue a renewal invoice; paying it extends your plan by one ${s.interval === "yearly" ? "year" : "month"}. Nothing renews unless you pay the invoice.`,
        [BILLING], chips("cancel", "how_to_pay"));
    }
    case "cancel":
      return make(f.subscription
        ? `You can cancel on the Billing page. Your ${f.subscription.planName} plan then keeps working until ${day(f.subscription.endsAt)} and won't renew. Fees already paid are not refunded automatically.`
        : "You don't have a plan to cancel. Listing fees are one-off, and an unpaid invoice can simply be left unpaid.", [BILLING], chips("refund"));
    case "dispute":
      return make("If an invoice looks wrong, open it on your Billing page and press Raise a payment issue, then say what's wrong (at least 10 characters). Staff review it, answer in writing, and nothing is changed until they do. Please don't send card or bank details in the message.", [BILLING], chips("failed_payment", "refund"));
    case "refund":
      return make("I can't promise or process refunds; staff decide them. If you were charged by mistake, charged twice, or the service wasn't delivered, raise a payment issue on the invoice and explain. Staff will reply in writing.", [BILLING], chips("dispute"));
    case "upgrade": {
      const r = f.recentListingFees;
      if (f.subscription) return make(`You're already on ${f.subscription.planName}. Take a look at the plans page if you'd like to compare.`, [PLANS], chips("subscription"));
      if (f.suggestedPlan && r.count >= 2 && f.suggestedPlan.monthlyExGstCents < r.exGstCents) {
        return make(`You've paid for ${r.count} listings in the last 90 days (${aud(r.exGstCents)} excluding GST). ${f.suggestedPlan.name} is ${aud(f.suggestedPlan.monthlyExGstCents)} a month excluding GST and adds more photos, storage and AI tools, so it may suit you better if you keep listing. It's your call; I can't tell you what's right for your finances.`, [PLANS, BILLING], chips("subscription"));
      }
      return make(f.suggestedPlan
        ? `For a single listing the flat listing fee is usually simplest. ${f.suggestedPlan.name} (${aud(f.suggestedPlan.monthlyExGstCents)} a month excluding GST) is worth a look if you plan to list more than one property.`
        : "For a single listing the flat listing fee is simplest. Subscription plans will appear on the plans page once prices are set.", [PLANS], chips("gst"));
    }
    case "advice":
      return make("I can't give tax, accounting or financial advice, including whether you can claim GST or deduct a fee. Your accountant can help. I can explain what's on your invoices, and your tax invoice shows the GST amount.", [BILLING], chips("invoice_copy", "gst"));
    case "privacy":
      return make("I can only talk about your own invoices and plan. I can't share or look up anyone else's billing.", [BILLING], chips("how_to_pay"));
    default:
      return make("Sorry, I didn't catch that. I can help with paying an invoice, GST, failed payments, bank transfer, your plan, cancelling, or a payment issue.", [BILLING],
        chips("how_to_pay", "gst", "failed_payment", "subscription", "dispute"));
  }
}

export const MAX_DISPUTE_REASON = 1000;
export const MIN_DISPUTE_REASON = 10;
export function parseDisputeReason(v: unknown): { ok: true; reason: string } | { ok: false; error: string } {
  const r = typeof v === "string" ? v.trim() : "";
  if (r.length < MIN_DISPUTE_REASON || r.length > MAX_DISPUTE_REASON) return { ok: false, error: `Tell us what is wrong, between ${MIN_DISPUTE_REASON} and ${MAX_DISPUTE_REASON} characters.` };
  // Card numbers must never be sent through this form.
  if (/\b(?:\d[ -]?){13,19}\b/.test(r)) return { ok: false, error: "Please don't include card or account numbers." };
  return { ok: true, reason: r };
}
