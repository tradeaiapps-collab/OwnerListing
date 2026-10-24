import { NextResponse } from "next/server";
import { getActor } from "../../../../../../src/server/context";
import { csrfGuard } from "../../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../../src/server/http";
import { startIdCheck } from "../../../../../../src/server/id-check";
import { getIdDeps } from "../../../../../../src/server/verification-context";

/** Buyers only. Starts a provider ID-check session and returns where to send the buyer. No images pass through us. */
export async function POST(req: Request) {
  const blocked = csrfGuard(req, { json: false });
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (actor.userType !== "buyer") return NextResponse.json({ error: "Buyers only." }, { status: 403 });
  const r = await startIdCheck(getIdDeps(), actor.userId);
  return r.ok ? NextResponse.json(r.value) : failure(r);
}
