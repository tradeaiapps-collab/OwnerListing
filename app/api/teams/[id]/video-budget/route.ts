import { NextResponse } from "next/server";
import { setTeamBudget, teamBudget } from "../../../../../src/domain/listing-video";
import { getActor } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { getVideoRepo, videoIds } from "../../../../../src/server/listing-video-db";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** The team's monthly video allowance and what has been spent this month (any member). */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await teamBudget(getVideoRepo(), actor, (await params).id, videoIds);
  return r.ok ? NextResponse.json({ budget: r.value }) : failure(r);
}
export const GET = withApi(handleGet);

/** Managers set the monthly budget. Body: { monthlyBudgetCents }. */
async function handlePut(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await setTeamBudget(getVideoRepo(), actor, (await params).id, await req.json().catch(() => null), videoIds);
  return r.ok ? NextResponse.json({ budget: r.value }) : failure(r);
}
export const PUT = withApi(handlePut);
