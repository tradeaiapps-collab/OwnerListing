import { NextResponse } from "next/server";
import { getActor, getDb } from "../../../../../../src/server/context";
import { csrfGuard } from "../../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../../src/server/http";
import { canManageListing, channexConnectUrl, syndicationDeps } from "../../../../../../src/server/syndication-db";
import { UUID_RE } from "../../../../../../src/server/staff-route";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Owner or full-scope agent: a one-time address (15 minutes, single use) of the Channex screen where they connect their own Airbnb, Booking.com or Vrbo account. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!UUID_RE.test(id) || !(await canManageListing(getDb(), id, actor.userId))) return failure({ ok: false, code: "not_found", message: "Listing not found." });
  const r = await channexConnectUrl(getDb(), syndicationDeps(), actor.userId, id);
  if (!r.ok) return NextResponse.json({ error: r.error, code: r.code }, { status: r.code === "failed" ? 502 : 409 });
  return NextResponse.json({ url: r.url }, { status: 201, headers: { "cache-control": "no-store" } });
}

export const POST = withApi(handlePost);
