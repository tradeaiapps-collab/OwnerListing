import { NextResponse } from "next/server";
import { marketReport } from "../../../../src/domain/property-intelligence";
import { buildBundle, loadIntel, noStore } from "../../../../src/server/property-intelligence";
import { withApi } from "../../../../src/server/api/with-api";

/** A written market report. Signed-in users only. Advisory; see INTEL_NOTE. */
async function handleGet(req: Request) {
  const p = new URL(req.url).searchParams;
  const ctx = await loadIntel(req, k => p.get(k));
  if (ctx instanceof NextResponse) return ctx;
  const b = buildBundle(ctx.query, ctx.comps, ctx.now);
  return NextResponse.json({ query: b.query, report: marketReport(b) }, { headers: noStore });
}

export const GET = withApi(handleGet);
