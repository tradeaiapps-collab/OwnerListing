import { NextResponse } from "next/server";
import { listAssignments } from "../../../src/domain/assignment-service";
import { getAssignmentRepo } from "../../../src/server/assignment-db";
import { getActor } from "../../../src/server/context";
import { failure, unauthenticated } from "../../../src/server/http";
import { withApi } from "../../../src/server/api/with-api";

/** The signed-in user's own assignments, as owner and as contractor. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await listAssignments(getAssignmentRepo(), actor);
  return r.ok ? NextResponse.json({ assignments: r.value }) : failure(r);
}

export const GET = withApi(handleGet);
