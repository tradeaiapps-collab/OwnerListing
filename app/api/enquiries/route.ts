import { NextResponse } from "next/server";
import { inbox } from "../../../src/domain/enquiry-service";
import { getActor } from "../../../src/server/context";
import { getEnquiryDeps } from "../../../src/server/enquiry-db";
import { unauthenticated } from "../../../src/server/http";

/** The signed-in person's threads (as buyer and as listing owner) with unread counts. */
export async function GET(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  return NextResponse.json({ items: await inbox(getEnquiryDeps(), actor) });
}
