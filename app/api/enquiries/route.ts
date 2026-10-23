import { NextResponse } from "next/server";
import { inbox } from "../../../src/domain/enquiry-service";
import { getActor, getEnquiryDeps } from "../../../src/server/context";
import { unauthenticated } from "../../../src/server/http";

/** The signed-in user's threads: ones they started and ones on their own listings. */
export async function GET(req: Request) {
  const actor = getActor(req);
  if (!actor) return unauthenticated();
  return NextResponse.json({ items: await inbox(getEnquiryDeps(), actor) });
}
