import { NextResponse } from "next/server";
import { getActor, getDb } from "../../../src/server/context";
import { unauthenticated } from "../../../src/server/http";
import { awaitingSignature } from "../../../src/server/transaction-db";
import { withApi } from "../../../src/server/api/with-api";

/** Documents waiting for the signed-in person's signature (open requests only), newest first. Titles only. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const rows = await awaitingSignature(getDb(), actor.userId);
  return NextResponse.json({ requests: rows.map(r => ({ id: r.id, title: r.title, listingId: r.listingId, expiresAt: r.expiresAt })) }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
