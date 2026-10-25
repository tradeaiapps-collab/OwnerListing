import { NextResponse } from "next/server";
import { parseMessageBody, startEnquiry } from "../../../../../src/domain/enquiry-service";
import { isUuid } from "../../../../../src/domain/offer-decision";
import { getActor } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { getEnquiryDeps } from "../../../../../src/server/enquiry-db";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { screenWithDefaults } from "../../../../../src/server/message-safety";
import { requireCurrentTerms } from "../../../../../src/server/terms-guard";

type Ctx = { params: Promise<{ id: string }> };

/** A verified buyer starts (or continues) their enquiry thread with the owner of a published listing. Body: { "body": "text" }. */
export async function POST(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const deps = getEnquiryDeps();
  const noTerms = await requireCurrentTerms(deps.termsCurrentFor, actor.userId);
  if (noTerms) return failure(noTerms);
  const { id } = await params;
  if (!isUuid(id)) return failure({ ok: false, code: "not_found", message: "Listing not found." });
  const body = parseMessageBody(await req.json().catch(() => null));
  if (!body.ok) return failure(body);
  const r = await startEnquiry(deps, actor, id, body.value);
  if (!r.ok) return failure(r);
  // The message is already stored; the safety filter only adds a warning for the owner and never blocks it.
  await screenWithDefaults(r.value.enquiry, r.value.message);
  return NextResponse.json(r.value, { status: 201 });
}
