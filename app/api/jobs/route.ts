import { NextResponse } from "next/server";
import { maskJobAddress } from "../../../src/domain/contractor-trust";
import { withApi } from "../../../src/server/api/with-api";
import { createPgMarketStore } from "../../../src/server/contractor-market-db";
import { getActor, getDb } from "../../../src/server/context";
import { unauthenticated } from "../../../src/server/http";

/** The signed-in user's jobs, as owner and as contractor, newest first. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const jobs = await createPgMarketStore(getDb()).listJobs(actor.userId);
  return NextResponse.json({ jobs: jobs.map(j => ({ ...maskJobAddress(j, actor.userId), role: j.ownerUserId === actor.userId ? "owner" : "contractor" })) });
}
export const GET = withApi(handleGet);
