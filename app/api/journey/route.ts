import { NextResponse } from "next/server";
import { nextStep, progress } from "../../../src/domain/journey";
import { getActor, getDb } from "../../../src/server/context";
import { unauthenticated } from "../../../src/server/http";
import { loadJourney } from "../../../src/server/journey";
import { withApi } from "../../../src/server/api/with-api";

/** The signed-in user's own checklist (yes/no facts and counts about their own records only). */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const j = await loadJourney(getDb(), actor).catch(() => null);
  if (!j) return NextResponse.json({ role: null, steps: [], next: null, progress: { done: 0, total: 0 } }, { headers: { "cache-control": "no-store" } });
  return NextResponse.json({ role: j.role, steps: j.steps, next: nextStep(j.steps), progress: progress(j.steps) }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
