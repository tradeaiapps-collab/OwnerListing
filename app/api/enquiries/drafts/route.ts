import { NextResponse } from "next/server";
import { listDrafts } from "../../../../src/domain/enquiry-service";
import { getActor } from "../../../../src/server/context";
import { getEnquiryDeps } from "../../../../src/server/enquiry-db";
import { failure, unauthenticated } from "../../../../src/server/http";

/** Owner only: auto-reply drafts waiting for review. Nothing in a draft has been sent. */
export async function GET(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await listDrafts(getEnquiryDeps(), actor);
  return r.ok ? NextResponse.json({ drafts: r.value }) : failure(r);
}
