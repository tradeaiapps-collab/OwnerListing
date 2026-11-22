import { NextResponse } from "next/server";
import { myDocuments } from "../../../src/domain/signing-service";
import { getActor } from "../../../src/server/context";
import { failure, unauthenticated } from "../../../src/server/http";
import { getSigningRepo } from "../../../src/server/signing-db";
import { withApi } from "../../../src/server/api/with-api";

/** Documents the signed-in person has to sign, has signed, or has sent. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await myDocuments(getSigningRepo(), actor);
  return r.ok ? NextResponse.json({ documents: r.value, viewerId: actor.userId }) : failure(r);
}

export const GET = withApi(handleGet);
