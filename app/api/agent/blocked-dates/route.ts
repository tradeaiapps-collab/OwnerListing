import { NextResponse } from "next/server";
import { getActor, getDb } from "../../../../src/server/context";
import { unauthenticated } from "../../../../src/server/http";
import { syndicationDeps, upcomingBlockedForAgent } from "../../../../src/server/syndication-db";
import { withApi } from "../../../../src/server/api/with-api";

/** Upcoming portal bookings and imported blocked dates on the listings the signed-in agent is appointed to; clashes first. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const today = syndicationDeps().now().slice(0, 10);
  return NextResponse.json({ stays: await upcomingBlockedForAgent(getDb(), actor.userId, today) }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
