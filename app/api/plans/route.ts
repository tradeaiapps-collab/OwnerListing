import { NextResponse } from "next/server";
import { gstCents, GST_RATE_PERCENT } from "../../../src/domain/billing";
import { pricedPlans } from "../../../src/domain/billing-service";
import { getBilling } from "../../../src/server/context";
import { withApi } from "../../../src/server/api/with-api";

/** Public: plan entitlements and the admin-set prices (excluding GST, with GST shown). A plan with no price has price null and cannot be bought. */
async function handleGet() {
  const plans = await pricedPlans(getBilling());
  return NextResponse.json({
    gstPercent: GST_RATE_PERCENT,
    plans: plans.map(p => ({
      id: p.id, name: p.name, maxPhotos: p.maxPhotos, storageGb: p.storageGb, features: p.features,
      price: p.priceCents === null ? null : { exGstCents: p.priceCents, gstCents: gstCents(p.priceCents), totalCents: p.priceCents + gstCents(p.priceCents) }
    }))
  });
}

export const GET = withApi(handleGet);
