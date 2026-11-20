import { NextResponse } from "next/server";
import { parseEmergencyProfile } from "../../../../src/domain/emergency";
import { withApi } from "../../../../src/server/api/with-api";
import { getActor, getDb } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { getProfilesPg, saveProfilePg } from "../../../../src/server/emergency-db";
import { failure, unauthenticated } from "../../../../src/server/http";

/** The signed-in contractor's own emergency settings, one per trade. The id always comes from the session. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  return NextResponse.json({ profiles: await getProfilesPg(getDb(), actor.userId) });
}

async function handlePut(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (actor.userType !== "vendor") return failure({ ok: false, code: "forbidden", message: "Only contractor accounts can take emergency jobs. Sign up as a contractor to list yourself." });
  const parsed = parseEmergencyProfile(await req.json().catch(() => null));
  if (!parsed.ok) return failure(parsed);
  await saveProfilePg(getDb(), actor.userId, parsed.value);
  return NextResponse.json({ profile: parsed.value });
}

export const GET = withApi(handleGet);
export const PUT = withApi(handlePut);
