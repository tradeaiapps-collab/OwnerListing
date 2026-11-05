import { NextResponse } from "next/server";
import { canReview, getMarketplaceDb, getPublicProfile, marketplaceNow } from "../../../../../src/server/agent-marketplace-db";
import { getActor } from "../../../../../src/server/context";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Public profile, portfolio and reviews of a listed agent. `canReview` is true only for a signed-in user who has dealt with the agent. */
async function handleGet(req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Agent not found." }, { status: 404 });
  const db = getMarketplaceDb();
  const profile = await getPublicProfile(db, id);
  if (!profile) return NextResponse.json({ error: "Agent not found." }, { status: 404 });
  const actor = await getActor(req);
  return NextResponse.json({ agent: profile, viewer: { signedIn: actor !== null, userType: actor?.userType ?? null, canReview: await canReview(db, actor, id, marketplaceNow()) } }, { headers: { "cache-control": "private, no-store" } });
}

export const GET = withApi(handleGet);
