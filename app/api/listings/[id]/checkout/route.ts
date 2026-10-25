import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createWestpacPayway, paywayConfigFromEnv } from "../../../../../src/adapters/westpac-payway";
import { startCheckout } from "../../../../../src/domain/billing-service";
import { getActor, getBilling } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Owner checkout: creates (or finds) the invoice for the chosen plan, then asks the payment provider for its hosted page.
 * The owner is redirected there, so card numbers never reach this app. While the provider is not connected this answers 503
 * and the invoice stays unpaid, so the listing cannot publish. Only the listing's owner can do this.
 */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const body = (await req.json().catch(() => null)) as { planId?: unknown } | null;
  const { id } = await params;
  const r = await startCheckout(getBilling(), actor.userId, id, typeof body?.planId === "string" ? body.planId : "", randomUUID);
  if (!r.ok) return failure({ ok: false, code: r.code, message: r.message });
  if (r.invoice.status === "paid") return NextResponse.json({ invoice: r.invoice, alreadyPaid: true });
  try {
    const payway = createWestpacPayway(paywayConfigFromEnv(process.env));
    const returnUrl = `${new URL(process.env["APP_URL"] ?? "").origin}/listings/${id}/checkout`;
    const { redirectUrl } = await payway.createHostedCheckout(r.invoice, returnUrl);
    return NextResponse.json({ invoice: r.invoice, redirectUrl });
  } catch {
    return NextResponse.json({ error: "Online payment is not available yet.", invoice: r.invoice }, { status: 503 });
  }
}

export const POST = withApi(handlePost);
