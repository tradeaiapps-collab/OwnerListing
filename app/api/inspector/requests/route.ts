import { NextResponse } from "next/server";
import { getActor } from "../../../../src/server/context";
import { unauthenticated } from "../../../../src/server/http";
import { getBookingRepo } from "../../../../src/server/inspection-marketplace-db";
import { withApi } from "../../../../src/server/api/with-api";

/** Open requests in the inspector's states (no buyer identity), and the inspector's own accepted jobs. Empty unless the profile is approved. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const repo = getBookingRepo();
  const [requests, jobs] = await Promise.all([repo.openRequests(actor.userId), repo.bookingsForInspector(actor.userId)]);
  const safeJobs = jobs.map(({ buyerId: _buyer, ...j }) => j);
  return NextResponse.json({ requests, jobs: safeJobs }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
