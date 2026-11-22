import { NextResponse } from "next/server";
import { ESIGN_CONSENT_VERSION, LIMITS, ipHash, parseSignature, plainText } from "../../../../src/domain/e-sign";
import { SIGN_ATTEMPT_RATE } from "../../../../src/domain/rate-limit";
import { clientIp } from "../../../../src/server/client-ip";
import { getActor, getDb, getDeps } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../src/server/http";
import { cancelRequest, expireIfDue, recordDecline, recordSignature, requestById, signersFor } from "../../../../src/server/transaction-db";
import { audit, notifyUser, readJson, UUID_RE } from "../../../../src/server/transaction-http";
import { withinRates } from "../../../../src/server/rate-guard";
import { withApi } from "../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };
const gone = () => failure({ ok: false, code: "not_found", message: "Document not found." });

/** Where to find the document for a request. Only the owner and the named signers can ask; everyone else gets 404. */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const id = (await params).id;
  const db = getDb(), deps = getDeps();
  const rq = UUID_RE.test(id) ? await requestById(db, id) : undefined;
  if (!rq) return gone();
  const isSigner = (await signersFor(db, id)).some(s => s.userId === actor.userId);
  const isOwner = (await deps.repo.get(rq.listingId))?.listing.ownerUserId === actor.userId;
  if (!isSigner && !isOwner) return gone();
  return NextResponse.json({ request: { id: rq.id, listingId: rq.listingId, documentId: rq.documentId, title: rq.title, status: rq.status } }, { headers: { "cache-control": "no-store" } });
}

/**
 * Body: { action: "sign", typedName, consent: true, consentVersion } | { action: "decline", reason? } | { action: "cancel" } (owner only).
 * Signing and declining are for the named signer, are final, and are recorded with a hash of the document and of the signing details.
 */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const id = (await params).id;
  const db = getDb(), deps = getDeps();
  const rq = UUID_RE.test(id) ? await requestById(db, id) : undefined;
  if (!rq) return gone();
  const signers = await signersFor(db, id);
  const mine = signers.find(s => s.userId === actor.userId);
  const listing = await deps.repo.get(rq.listingId);
  const isOwner = listing?.listing.ownerUserId === actor.userId;
  if (!mine && !isOwner) return gone();
  const body = await readJson(req);
  if (body instanceof NextResponse) return body;
  await expireIfDue(db, id, deps.now());
  const action = body["action"];
  if (action === "cancel") {
    if (!isOwner) return failure({ ok: false, code: "forbidden", message: "Only the owner can cancel a request." });
    if (!(await cancelRequest(db, id, actor.userId, deps.now()))) return NextResponse.json({ error: "This request is no longer open." }, { status: 409 });
    await audit("signature.cancelled", "signature_request", id, actor.userId, { listingId: rq.listingId });
    return NextResponse.json({ status: "cancelled" });
  }
  if (!mine) return gone();
  if (action === "decline") {
    const reason = plainText(body["reason"], LIMITS.reason, false);
    if (reason === undefined) return NextResponse.json({ error: `Reason can be up to ${LIMITS.reason} plain characters.` }, { status: 400 });
    const r = await recordDecline(db, id, actor.userId, reason, deps.now());
    if (!r.ok) return NextResponse.json({ error: r.message }, { status: r.code === "not_found" ? 404 : 409 });
    await audit("signature.declined", "signature_request", id, actor.userId, { listingId: rq.listingId });
    if (listing) await notifyUser(listing.listing.ownerUserId, "signature-declined", "A signer declined a document", "A signer declined to sign a document you sent. Sign in to see the request.");
    return NextResponse.json({ status: "declined" });
  }
  if (action !== "sign") return NextResponse.json({ error: "Choose sign, decline or cancel." }, { status: 400 });
  if (!(await withinRates(db, "sign-attempt-user", [actor.userId], { windowMs: SIGN_ATTEMPT_RATE.windowMs, limit: SIGN_ATTEMPT_RATE.perUser }))) {
    return NextResponse.json({ error: "Too many signing attempts. Try again in a few minutes." }, { status: 429, headers: { "retry-after": "900" } });
  }
  const sig = parseSignature(body);
  if (!sig.ok) return NextResponse.json({ error: sig.message }, { status: 400 });
  const r = await recordSignature(db, id, actor.userId, sig.typedName, ipHash(clientIp(req), process.env["SESSION_SECRET"]), ESIGN_CONSENT_VERSION, deps.now());
  if (!r.ok) return NextResponse.json({ error: r.message }, { status: r.code === "not_found" ? 404 : 409 });
  await audit("signature.signed", "signature_request", id, actor.userId, { listingId: rq.listingId, completed: r.completed });
  if (r.completed && listing) {
    for (const uid of new Set([listing.listing.ownerUserId, ...signers.map(s => s.userId)])) {
      await notifyUser(uid, "signature-complete", "A document has been signed by everyone", "Everyone has signed. The signed document and its record are on the listing's documents page.");
    }
  }
  return NextResponse.json({ status: r.completed ? "completed" : "pending", evidenceSha256: r.evidenceSha256 });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
