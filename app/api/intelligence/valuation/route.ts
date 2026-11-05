import { NextResponse } from "next/server";
import { valuationBreakdown } from "../../../../src/domain/market-forecast";
import { INTEL_NOTE } from "../../../../src/domain/property-intelligence";
import { buildBundle, loadIntel, noStore } from "../../../../src/server/property-intelligence";
import { withApi } from "../../../../src/server/api/with-api";

/** Automated valuation (AVM): estimated value, range, confidence and how it was worked out. Signed-in users only. Advisory; see INTEL_NOTE. */
async function handleGet(req: Request) {
  const p = new URL(req.url).searchParams;
  const ctx = await loadIntel(req, k => p.get(k));
  if (ctx instanceof NextResponse) return ctx;
  const b = buildBundle(ctx.query, ctx.comps, ctx.now);
  return NextResponse.json({ query: b.query, valuation: b.valuation ? { state: "ready", ...b.valuation, estimate: undefined, breakdown: valuationBreakdown(ctx.query, ctx.comps, ctx.now, b.valuation) } : { state: "unavailable", message: "Not enough recent comparable results to estimate a value." }, note: INTEL_NOTE }, { headers: noStore });
}

export const GET = withApi(handleGet);
