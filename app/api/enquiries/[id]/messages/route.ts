import { NextResponse } from "next/server";
import { getThread, parseMessageBody, reply } from "../../../../../src/domain/enquiry-service";
import { isUuid } from "../../../../../src/domain/offer-decision";
import { getActor } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { getEnquiryDeps } from "../../../../../src/server/enquiry-db";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { screenWithDefaults } from "../../../../../src/server/message-safety";
import { requireCurrentTerms } from "../../../../../src/server/terms-guard";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

const notFound = { ok: false, code: "not_found", message: "Enquiry not found." } as const;

// Only GET and POST exist on purpose. Enquiry messages are never edited or deleted (CLAUDE.md).

/** The thread, for its buyer and the listing's owner only. Reading marks it read for the reader. */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!isUuid(id)) return failure(notFound);
  const r = await getThread(getEnquiryDeps(), actor, id);
  return r.ok ? NextResponse.json(r.value) : failure(r);
}

/** Adds a message to the thread. Body: { "body": "text" }. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const deps = getEnquiryDeps();
  const noTerms = await requireCurrentTerms(deps.termsCurrentFor, actor.userId);
  if (noTerms) return failure(noTerms);
  const { id } = await params;
  if (!isUuid(id)) return failure(notFound);
  const body = parseMessageBody(await req.json().catch(() => null));
  if (!body.ok) return failure(body);
  const r = await reply(deps, actor, id, body.value);
  if (!r.ok) return failure(r);
  // Buyer messages only (the helper checks). The message is already stored; a flag never blocks or changes it.
  const enquiry = await deps.enquiries.get(id);
  if (enquiry) await screenWithDefaults(enquiry, r.value);
  return NextResponse.json({ message: r.value }, { status: 201 });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
