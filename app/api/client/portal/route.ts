import { NextResponse } from "next/server";
import { listPortal } from "../../../../src/domain/client-portal";
import { inbox } from "../../../../src/domain/enquiry-service";
import { getClientPortalRepo } from "../../../../src/server/client-portal-db";
import { getActor } from "../../../../src/server/context";
import { getEnquiryDeps } from "../../../../src/server/enquiry-db";
import { failure, unauthenticated } from "../../../../src/server/http";
import { withApi } from "../../../../src/server/api/with-api";

/** Everything the signed-in client may see in one call: their documents, their bookings and their message threads. Nothing else is readable. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await listPortal(getClientPortalRepo(), actor);
  if (!r.ok) return failure(r);
  const threads = (await inbox(getEnquiryDeps(), actor)).map(t => ({ id: t.enquiry.id, listingTitle: t.listingTitle, role: t.role, unread: t.unread, startedAt: t.enquiry.createdAt }));
  return NextResponse.json({ ...r.value, threads, role: actor.userType }, { headers: { "cache-control": "private, no-store" } });
}

export const GET = withApi(handleGet);
