import { NextResponse } from "next/server";
import { getActor } from "../../../../src/server/context";
import { getDb } from "../../../../src/server/context";
import { queueForAuthor } from "../../../../src/server/elena-scheduling-db";
import { unauthenticated } from "../../../../src/server/http";
import { withApi } from "../../../../src/server/api/with-api";

/** Elena's drafts for the signed-in inspector: { suggestions } waiting for a decision, and { history } of sent, skipped and expired ones. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  return NextResponse.json(await queueForAuthor(getDb(), actor.userId), { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
