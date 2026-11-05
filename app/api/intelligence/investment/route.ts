import { NextResponse } from "next/server";
import { buildExtended, SCORE_NOTE } from "../../../../src/domain/market-forecast";
import { buildBundle, loadIntel, noStore } from "../../../../src/server/property-intelligence";
import { withApi } from "../../../../src/server/api/with-api";

/** Area fundamentals score (growth, yield, time to sell, momentum, consistency), each component shown. Signed-in users only. Not advice; see SCORE_NOTE. */
async function handleGet(req: Request) {
  const p = new URL(req.url).searchParams;
  const ctx = await loadIntel(req, k => p.get(k));
  if (ctx instanceof NextResponse) return ctx;
  const b = buildBundle(ctx.query, ctx.comps, ctx.now);
  return NextResponse.json({ query: b.query, score: buildExtended(ctx.query, ctx.comps, ctx.now, b).score, note: SCORE_NOTE }, { headers: noStore });
}

export const GET = withApi(handleGet);
