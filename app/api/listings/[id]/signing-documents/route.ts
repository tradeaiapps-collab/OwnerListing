import { NextResponse } from "next/server";
import { documentsForListing, generateDocument } from "../../../../../src/domain/signing-service";
import { getActor } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { getSigningRepo, requestContext, signingIds } from "../../../../../src/server/signing-db";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** The listing owner's documents for this listing. Anyone else gets 404. */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const r = await documentsForListing(getSigningRepo(), actor, id);
  return r.ok ? NextResponse.json({ documents: r.value }) : failure(r);
}

/**
 * The listing owner generates a draft from a published template.
 * Body: { "templateKey": "agent_appointment", "values": { field: "text" }, "signers": [{ "email": "...", "roleLabel": "Agent" }] }.
 * Every signer needs an active account. The draft is sent for signature separately, so the owner can read it first.
 */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const r = await generateDocument(getSigningRepo(), actor, id, await req.json().catch(() => null), signingIds, requestContext(req));
  return r.ok ? NextResponse.json({ document: r.value }, { status: 201 }) : failure(r);
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
