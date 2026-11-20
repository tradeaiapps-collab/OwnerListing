import { NextResponse } from "next/server";
import { TRADES } from "../../../src/domain/contractor-market";
import { parseContractorProfile } from "../../../src/domain/contractor-dispatch";
import { withApi } from "../../../src/server/api/with-api";
import { ENSURE_PAGE_SQL } from "../../../src/server/contractor-market-db";
import { createPgContractorProfileStore } from "../../../src/server/contractor-profile-db";
import { getActor, getDb } from "../../../src/server/context";
import { csrfGuard } from "../../../src/server/csrf";
import { failure, unauthenticated } from "../../../src/server/http";

/** The signed-in photographer's or inspector's own service areas. Vendor and agent accounts only; the id always comes from the session. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const store = createPgContractorProfileStore(getDb());
  const [photographer, inspector, pestControl, other] = await Promise.all(TRADES.map(t => store.get(actor.userId, t)));
  return NextResponse.json({ profiles: { photographer: photographer ?? null, inspector: inspector ?? null, pest_control: pestControl ?? null, other: other ?? null } });
}

async function handlePut(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (actor.userType !== "vendor" && actor.userType !== "agent") return failure({ ok: false, code: "forbidden", message: "Only contractor accounts have service areas." });
  const parsed = parseContractorProfile(await req.json().catch(() => null));
  if (!parsed.ok) return failure(parsed);
  await createPgContractorProfileStore(getDb()).save(actor.userId, parsed.value.kind, parsed.value.profile);
  await getDb().query(ENSURE_PAGE_SQL, [actor.userId]); // every contractor with service areas gets a CON number
  return NextResponse.json({ profile: parsed.value.profile });
}

export const GET = withApi(handleGet);
export const PUT = withApi(handlePut);
