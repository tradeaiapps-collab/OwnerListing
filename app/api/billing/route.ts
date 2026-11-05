import { NextResponse } from "next/server";
import { bankDetailsFromEnv, cardPaymentsConfigured } from "../../../src/adapters/bank-transfer";
import { GST_RATE_PERCENT } from "../../../src/domain/billing";
import { SUBSCRIPTION_PLANS, YEARLY_MONTHS_CHARGED, periodPriceCents } from "../../../src/domain/plans";
import { getActor, getDb } from "../../../src/server/context";
import { unauthenticated } from "../../../src/server/http";
import { currentMonthlyPrices, loadMyBilling } from "../../../src/server/subscription-db";
import { gstCents } from "../../../src/domain/billing";
import { withApi } from "../../../src/server/api/with-api";

const NO_STORE = { "cache-control": "no-store" } as const;

/** The signed-in person's own invoices, plan, payment issues and the plans they can choose. Nothing about anyone else. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const db = getDb();
  const [mine, prices] = await Promise.all([loadMyBilling(db, actor.userId), currentMonthlyPrices(db)]);
  const plans = SUBSCRIPTION_PLANS.filter(p => p.audience === actor.userType).map(p => {
    const monthly = prices[p.id];
    const price = (interval: "monthly" | "yearly") => {
      if (monthly === undefined) return null;
      const ex = periodPriceCents(monthly, interval), gst = gstCents(ex);
      return { exGstCents: ex, gstCents: gst, totalCents: ex + gst };
    };
    return { id: p.id, name: p.name, maxPhotos: p.maxPhotos, storageGb: p.storageGb, maxActiveListings: p.maxActiveListings ?? null, features: p.features, monthly: price("monthly"), yearly: price("yearly") };
  });
  return NextResponse.json({
    ...mine, plans, userType: actor.userType, gstPercent: GST_RATE_PERCENT, yearlyMonthsCharged: YEARLY_MONTHS_CHARGED,
    cardAvailable: cardPaymentsConfigured(process.env), bankTransferAvailable: bankDetailsFromEnv(process.env) !== null
  }, { headers: NO_STORE });
}

export const GET = withApi(handleGet);
