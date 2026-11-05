import { NextResponse } from "next/server";
import { INTEL_NOTE } from "../../../../src/domain/property-intelligence";
import { buildBundle, loadIntel, noStore } from "../../../../src/server/property-intelligence";
import { withApi } from "../../../../src/server/api/with-api";

/** Market insights: median, change, sales pace and days on the market for the area. Signed-in users only. Advisory; see INTEL_NOTE. */
async function handleGet(req: Request) {
  const p = new URL(req.url).searchParams;
  const ctx = await loadIntel(req, k => p.get(k));
  if (ctx instanceof NextResponse) return ctx;
  const b = buildBundle(ctx.query, ctx.comps, ctx.now);
  return NextResponse.json({ query: b.query, market: b.market, note: INTEL_NOTE }, { headers: noStore });
}

export const GET = withApi(handleGet);
