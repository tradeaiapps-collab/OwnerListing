import { NextResponse } from "next/server";
import { documentsForListing, generateDocument, SIGNER_UNAVAILABLE } from "../../../../../src/domain/signing-service";
import { getActor, getDb } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { SIGNER_LOOKUP_RATE } from "../../../../../src/domain/rate-limit";
import { clientIp } from "../../../../../src/server/client-ip";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { withinRates } from "../../../../../src/server/rate-guard";
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
 * The answer never says whether an address has an account (security review 2026-10): a draft made or not, it is always 200 with the
 * same message, and the owner finds the draft in the listing's document list. Limited to 5 a hour per address and 20 per user.
 */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const db = getDb();
  const [byIp, byUser] = [
    await withinRates(db, "signer-lookup-ip", [clientIp(req)], { windowMs: SIGNER_LOOKUP_RATE.windowMs, limit: SIGNER_LOOKUP_RATE.perIp }),
    await withinRates(db, "signer-lookup-user", [actor.userId], { windowMs: SIGNER_LOOKUP_RATE.windowMs, limit: SIGNER_LOOKUP_RATE.perUser })
  ];
  if (!byIp || !byUser) return NextResponse.json({ error: "Too many document requests. Try again in an hour." }, { status: 429, headers: { "retry-after": "3600" } });
  const r = await generateDocument(getSigningRepo(), actor, id, body, signingIds, requestContext(req));
  if (!r.ok && r.message !== SIGNER_UNAVAILABLE) return failure(r);
  return NextResponse.json({ status: "received", message: "Your request was received. If everyone you listed can sign, the draft is now in this listing's documents. Anyone without an active account must sign up first." });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
