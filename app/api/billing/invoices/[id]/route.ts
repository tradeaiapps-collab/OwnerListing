import { NextResponse } from "next/server";
import { bankDetailsFromEnv, cardPaymentsConfigured } from "../../../../../src/adapters/bank-transfer";
import { GST_RATE_PERCENT } from "../../../../../src/domain/billing";
import { readBrand } from "../../../../../src/config/brand";
import { getActor, getDb } from "../../../../../src/server/context";
import { unauthenticated } from "../../../../../src/server/http";
import { getMyInvoice } from "../../../../../src/server/subscription-db";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** One of the signed-in person's own invoices as a tax invoice, with bank-transfer details while it is unpaid. Anyone else's looks missing. */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const invoice = await getMyInvoice(getDb(), actor.userId, id);
  if (!invoice) return NextResponse.json({ error: "Invoice not found." }, { status: 404 });
  const bank = invoice.status === "pending" ? bankDetailsFromEnv(process.env) : null;
  return NextResponse.json({
    invoice, gstPercent: GST_RATE_PERCENT, seller: { name: readBrand().name, abn: process.env["SELLER_ABN"] ?? null },
    bank, cardAvailable: cardPaymentsConfigured(process.env)
  }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
