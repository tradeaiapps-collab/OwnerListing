import { NextResponse } from "next/server";
import { getActor, getDb } from "../../../src/server/context";
import { myRentals } from "../../../src/server/elena-rentals-db";
import { unauthenticated } from "../../../src/server/http";
import { withApi } from "../../../src/server/api/with-api";

/** The signed-in person's own rental applications (with viewing times Elena is offering), tenancies and repair requests. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  return NextResponse.json(await myRentals(getDb(), actor.userId, new Date().toISOString()), { headers: { "cache-control": "private, no-store" } });
}

export const GET = withApi(handleGet);
