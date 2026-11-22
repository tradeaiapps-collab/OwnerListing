import { NextResponse } from "next/server";
import { suggestFor } from "../../../../../../src/domain/job-board";
import { withApi } from "../../../../../../src/server/api/with-api";
import { createPgMarketStore } from "../../../../../../src/server/contractor-market-db";
import { getActor, getDb } from "../../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../../src/server/http";

type Ctx = { params: Promise<{ id: string }> };

/** Elena's best matches for ?kind= at this listing, by area, rating, price and availability. Owner only. Nothing is booked. */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const r = await suggestFor({ store: createPgMarketStore(getDb()) }, actor, id, new URL(req.url).searchParams.get("kind"));
  return r.ok ? NextResponse.json({ suggestions: r.value.map(x => ({ ...x.card, score: x.score, reasons: x.reasons })) }) : failure(r);
}
export const GET = withApi(handleGet);
