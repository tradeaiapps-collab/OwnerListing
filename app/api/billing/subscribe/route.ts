import { NextResponse } from "next/server";
import { isBillingInterval } from "../../../../src/domain/plans";
import { getActor, getDb } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { unauthenticated } from "../../../../src/server/http";
import { startSubscription } from "../../../../src/server/subscription-db";
import { withApi } from "../../../../src/server/api/with-api";

/** Body: { planId, interval: "monthly" | "yearly" }. Creates a pending plan and its first invoice; the plan starts only when that invoice is paid. */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const b = (await req.json().catch(() => null)) as { planId?: unknown; interval?: unknown } | null;
  if (typeof b?.planId !== "string" || !isBillingInterval(b.interval)) return NextResponse.json({ error: "Choose a plan and monthly or yearly." }, { status: 400 });
  const r = await startSubscription(getDb(), actor.userId, actor.userType, b.planId, b.interval, new Date().toISOString());
  if (!r.ok) return NextResponse.json({ error: r.message }, { status: r.code === "conflict" ? 409 : 400 });
  return NextResponse.json({ invoice: r.invoice, subscription: r.subscription }, { status: 201 });
}

export const POST = withApi(handlePost);
