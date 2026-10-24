import { NextResponse } from "next/server";
import { getAutoReply, updateAutoReply } from "../../../../src/domain/enquiry-service";
import { getActor } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { getEnquiryDeps } from "../../../../src/server/enquiry-db";
import { failure, unauthenticated } from "../../../../src/server/http";

/** Owner only: the auto-reply preview switches (on/off, pause, review window). */
export async function GET(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await getAutoReply(getEnquiryDeps(), actor);
  return r.ok ? NextResponse.json({ settings: r.value }) : failure(r);
}

/** Owner only. Body: any of { enabled, paused, reviewWindowMinutes, templateBody }. A template is approved by the owner writing it. */
export async function POST(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await updateAutoReply(getEnquiryDeps(), actor, await req.json().catch(() => null));
  return r.ok ? NextResponse.json({ settings: r.value }) : failure(r);
}
