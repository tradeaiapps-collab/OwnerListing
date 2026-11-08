import { NextResponse } from "next/server";
import { BILLING_QUESTION_MAX, BILLING_TOPICS, answerBilling, matchBillingTopic, type BillingFacts, type BillingTopic } from "../../../../src/domain/billing-assistant";
import { bankDetailsFromEnv, cardPaymentsConfigured } from "../../../../src/adapters/bank-transfer";
import { SUBSCRIPTION_PLANS } from "../../../../src/domain/plans";
import { getActor, getDb } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { unauthenticated } from "../../../../src/server/http";
import { currentMonthlyPrices, loadMyBilling } from "../../../../src/server/subscription-db";
import { withApi } from "../../../../src/server/api/with-api";

const NO_STORE = { "cache-control": "no-store" } as const;

/**
 * Elena's billing help. Body: { text?: up to 300 characters, topic?: one of the topics }. The answer is built from the signed-in person's own
 * invoices and plan only. The typed text picks a topic and is then dropped: it is not stored or logged.
 */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const raw = await req.text().catch(() => "");
  if (raw.length > 2048) return NextResponse.json({ error: "The question is too long." }, { status: 413 });
  let b: { text?: unknown; topic?: unknown } = {};
  try { const v: unknown = JSON.parse(raw); if (v && typeof v === "object" && !Array.isArray(v)) b = v as typeof b; } catch { return NextResponse.json({ error: "Send a JSON object." }, { status: 400 }); }
  if (b.text !== undefined && (typeof b.text !== "string" || b.text.length > BILLING_QUESTION_MAX)) return NextResponse.json({ error: `Questions can be up to ${BILLING_QUESTION_MAX} characters.` }, { status: 400 });
  const topic: BillingTopic = typeof b.topic === "string" && (BILLING_TOPICS as readonly string[]).includes(b.topic) ? (b.topic as BillingTopic) : matchBillingTopic(b.text);
  const db = getDb();
  const [mine, prices] = await Promise.all([loadMyBilling(db, actor.userId), currentMonthlyPrices(db)]);
  const priced = SUBSCRIPTION_PLANS.filter(p => p.audience === actor.userType && prices[p.id] !== undefined).sort((a, c) => (prices[a.id] ?? 0) - (prices[c.id] ?? 0))[0];
  const sub = mine.subscription;
  const planName = (id: string) => SUBSCRIPTION_PLANS.find(p => p.id === id)?.name ?? id;
  const facts: BillingFacts = {
    userType: actor.userType,
    invoices: mine.invoices.slice(0, 50).map(i => ({
      number: i.invoiceNumber ?? i.id.slice(0, 8), kind: i.kind ?? "other", totalCents: i.totalCents, status: i.status,
      ...(i.dueAt ? { dueAt: i.dueAt } : {}), ...(i.paymentMethod ? { paymentMethod: i.paymentMethod } : {}),
      disputeOpen: mine.disputes.some(d => d.invoiceId === i.id && d.status === "open")
    })),
    ...(sub ? { subscription: { planName: planName(sub.planId), status: sub.status, interval: sub.interval, endsAt: sub.endsAt, cancelAtPeriodEnd: sub.cancelAtPeriodEnd } } : {}),
    cardAvailable: cardPaymentsConfigured(process.env), bankTransferAvailable: bankDetailsFromEnv(process.env) !== null,
    recentListingFees: mine.recentListingFees,
    ...(priced ? { suggestedPlan: { name: priced.name, monthlyExGstCents: prices[priced.id] as number } } : {}),
    now: new Date().toISOString()
  };
  return NextResponse.json(answerBilling(topic, facts), { headers: NO_STORE });
}

export const POST = withApi(handlePost);
