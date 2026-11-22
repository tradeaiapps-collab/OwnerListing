import { NextResponse } from "next/server";
import { listInspections } from "../../../src/domain/inspection";
import { getActor } from "../../../src/server/context";
import { failure, unauthenticated } from "../../../src/server/http";
import { getInspectionRepo } from "../../../src/server/inspection-db";
import { withApi } from "../../../src/server/api/with-api";

/** Every inspection the signed-in user is part of: as owner/agent, as inspector, or as someone a report was shared with. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await listInspections(getInspectionRepo(), actor);
  return r.ok ? NextResponse.json({ inspections: r.value }, { headers: { "cache-control": "private, no-store" } }) : failure(r);
}

export const GET = withApi(handleGet);
