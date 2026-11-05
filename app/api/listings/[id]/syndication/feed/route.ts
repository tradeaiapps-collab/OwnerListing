import { NextResponse } from "next/server";
import { getActor, getDb } from "../../../../../../src/server/context";
import { csrfGuard } from "../../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../../src/server/http";
import { canManageListing, rotateFeedToken, syndicationDeps } from "../../../../../../src/server/syndication-db";
import { UUID_RE } from "../../../../../../src/server/staff-route";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Makes a new calendar link (iCal, booked dates only) to paste into a portal. Replaces the old link, which stops working. The link is shown once. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!UUID_RE.test(id) || !(await canManageListing(getDb(), id, actor.userId))) return failure({ ok: false, code: "not_found", message: "Listing not found." });
  const base = process.env["APP_URL"]?.replace(/\/+$/, "");
  if (!base) return NextResponse.json({ error: "The site address is not configured yet.", code: "not_configured" }, { status: 503 });
  const token = await rotateFeedToken(getDb(), actor.userId, id, syndicationDeps().now());
  return NextResponse.json({ url: `${base}/api/syndication/ical/${token}` }, { status: 201, headers: { "cache-control": "no-store" } });
}

export const POST = withApi(handlePost);
