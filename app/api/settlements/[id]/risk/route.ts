import { NextResponse } from "next/server";
import { isUuid } from "../../../../../src/domain/offer-decision";
import { getActor, getDb } from "../../../../../src/server/context";
import { unauthenticated } from "../../../../../src/server/http";
import { partyRiskDetail } from "../../../../../src/server/settlement-risk-db";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };
const fail = (status: number, error: string) => NextResponse.json({ error }, { status });

/** Risk advice for the owner or appointed agent of this settlement. The buyer gets a 403. */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!isUuid(id)) return fail(404, "Settlement not found.");
  const r = await partyRiskDetail(getDb(), actor.userId, id);
  return r.ok ? NextResponse.json(r.value, { headers: { "cache-control": "no-store" } }) : fail(r.status, r.error);
}

export const GET = withApi(handleGet);
