import { NextResponse } from "next/server";
import { parseMarketplaceProfile } from "../../../../src/domain/agent-marketplace";
import { getMarketplaceDb, getOwnMarketplace, marketplaceNow, saveOwnMarketplace } from "../../../../src/server/agent-marketplace-db";
import { getActor, getDb } from "../../../../src/server/context";
import { guardContent } from "../../../../src/server/content-guard";
import { createPgContentFlagStore } from "../../../../src/server/content-flag-db";
import { csrfGuard } from "../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../src/server/http";
import { withApi } from "../../../../src/server/api/with-api";

/** The signed-in agent's marketplace settings, weekly hours and own portfolio entries. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await getOwnMarketplace(getMarketplaceDb(), actor);
  return r.ok ? NextResponse.json(r.value, { headers: { "cache-control": "no-store" } }) : failure(r);
}

/** Replaces the marketplace settings and weekly hours. The agent id comes from the session. */
async function handlePut(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const v = parseMarketplaceProfile(await req.json().catch(() => null));
  if (!v.ok) return failure(v);
  // Contact details, abuse and spam in the public headline, specialties and languages. Refused text is not saved.
  const g = await guardContent(createPgContentFlagStore(getDb()), { source: "profile", subjectType: "agent_profile", userId: actor.userId,
    fields: { headline: v.value.headline, specialties: v.value.specialties.join(", "), languages: v.value.languages.join(", ") } });
  if (!g.ok) return failure({ ok: false, code: "invalid", message: g.message });
  const r = await saveOwnMarketplace(getMarketplaceDb(), actor, v.value, marketplaceNow());
  if (r.ok) await g.after(actor.userId);
  return r.ok ? NextResponse.json(r.value) : failure(r);
}

export const GET = withApi(handleGet);
export const PUT = withApi(handlePut);
