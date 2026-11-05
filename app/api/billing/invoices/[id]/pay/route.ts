import { NextResponse } from "next/server";
import { createWestpacPayway, paywayConfigFromEnv } from "../../../../../../src/adapters/westpac-payway";
import { getActor, getDb } from "../../../../../../src/server/context";
import { csrfGuard } from "../../../../../../src/server/csrf";
import { unauthenticated } from "../../../../../../src/server/http";
import { getMyInvoice } from "../../../../../../src/server/subscription-db";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Card payment for one of the person's own unpaid invoices: asks the provider for its hosted page. 503 until the provider is connected. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req, { json: false });
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const invoice = await getMyInvoice(getDb(), actor.userId, id);
  if (!invoice) return NextResponse.json({ error: "Invoice not found." }, { status: 404 });
  if (invoice.status === "paid") return NextResponse.json({ alreadyPaid: true });
  if (invoice.status !== "pending") return NextResponse.json({ error: `This invoice is ${invoice.status}.` }, { status: 409 });
  try {
    const payway = createWestpacPayway(paywayConfigFromEnv(process.env));
    const returnUrl = `${new URL(process.env["APP_URL"] ?? "").origin}/billing/${invoice.id}`;
    const { redirectUrl } = await payway.createHostedCheckout(invoice, returnUrl);
    return NextResponse.json({ redirectUrl });
  } catch {
    return NextResponse.json({ error: "Card payment is not available yet. You can pay by bank transfer if it is shown on the invoice." }, { status: 503 });
  }
}

export const POST = withApi(handlePost);
