import { NextResponse } from "next/server";
import { parseContractorProfile } from "../../../src/domain/contractor-dispatch";
import { withApi } from "../../../src/server/api/with-api";
import { createPgContractorProfileStore } from "../../../src/server/contractor-profile-db";
import { getActor, getDb } from "../../../src/server/context";
import { csrfGuard } from "../../../src/server/csrf";
import { failure, unauthenticated } from "../../../src/server/http";

/** The signed-in photographer's or inspector's own service areas. Vendor and agent accounts only; the id always comes from the session. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const store = createPgContractorProfileStore(getDb());
  const [photographer, inspector] = await Promise.all([store.get(actor.userId, "photographer"), store.get(actor.userId, "inspector")]);
  return NextResponse.json({ profiles: { photographer: photographer ?? null, inspector: inspector ?? null } });
}

async function handlePut(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (actor.userType !== "vendor" && actor.userType !== "agent") return failure({ ok: false, code: "forbidden", message: "Only photographer and inspector accounts have service areas." });
  const parsed = parseContractorProfile(await req.json().catch(() => null));
  if (!parsed.ok) return failure(parsed);
  await createPgContractorProfileStore(getDb()).save(actor.userId, parsed.value.kind, parsed.value.profile);
  return NextResponse.json({ profile: parsed.value.profile });
}

export const GET = withApi(handleGet);
export const PUT = withApi(handlePut);
