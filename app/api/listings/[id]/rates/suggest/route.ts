import { NextResponse } from "next/server";
import { toRatesView } from "../../../../../../src/domain/listing-rates";
import { getDb, getDeps } from "../../../../../../src/server/context";
import { getRatesProvider } from "../../../../../../src/server/rates-provider";
import { requireListingHandler } from "../../../../../../src/server/owner-listing";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Figures a rates provider (today: the imported file) holds for this listing's address, for the owner to review and accept in the form.
 * Nothing is saved here. Owner or appointed agent only. Returns { suggestion: { view, rates, source, asAt } | null }.
 */
async function handleGet(req: Request, { params }: Ctx) {
  const { id } = await params;
  const h = await requireListingHandler(req, id, "listing.describe");
  if (h instanceof NextResponse) return h;
  const l = (await getDeps().repo.get(id))?.listing;
  if (!l || l.transactionType !== "sale") return NextResponse.json({ error: "Listing not found." }, { status: 404 });
  const rec = await getRatesProvider(getDb()).lookup({ state: l.jurisdiction, address: l.address });
  const body = rec ? { view: toRatesView({ ...rec.rates, asAt: rec.asAt }), rates: { ...rec.rates, asAt: rec.asAt }, source: rec.source, asAt: rec.asAt } : null;
  return NextResponse.json({ suggestion: body }, { headers: { "cache-control": "private, no-store" } });
}

export const GET = withApi(handleGet);
