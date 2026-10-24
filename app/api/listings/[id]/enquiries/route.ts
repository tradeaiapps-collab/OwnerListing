import { NextResponse } from "next/server";
import { parseMessageBody, startEnquiry } from "../../../../../src/domain/enquiry-service";
import { isUuid } from "../../../../../src/domain/offer-decision";
import { getActor } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { getEnquiryDeps } from "../../../../../src/server/enquiry-db";
import { failure, unauthenticated } from "../../../../../src/server/http";

type Ctx = { params: Promise<{ id: string }> };

/** A verified buyer starts (or continues) their enquiry thread with the owner of a published listing. Body: { "body": "text" }. */
export async function POST(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!isUuid(id)) return failure({ ok: false, code: "not_found", message: "Listing not found." });
  const body = parseMessageBody(await req.json().catch(() => null));
  if (!body.ok) return failure(body);
  const r = await startEnquiry(getEnquiryDeps(), actor, id, body.value);
  return r.ok ? NextResponse.json(r.value, { status: 201 }) : failure(r);
}
