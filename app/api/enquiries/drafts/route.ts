import { NextResponse } from "next/server";
import { listDrafts } from "../../../../src/domain/enquiry-service";
import { getActor } from "../../../../src/server/context";
import { getEnquiryDeps } from "../../../../src/server/enquiry-db";
import { failure, unauthenticated } from "../../../../src/server/http";
import { withApi } from "../../../../src/server/api/with-api";

/** Owner only: auto-reply drafts waiting for review. Nothing in a draft has been sent. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await listDrafts(getEnquiryDeps(), actor);
  return r.ok ? NextResponse.json({ drafts: r.value }) : failure(r);
}

export const GET = withApi(handleGet);
