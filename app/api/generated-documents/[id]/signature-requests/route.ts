import { NextResponse } from "next/server";
import { expiryFrom, parseSigners } from "../../../../../src/domain/e-sign";
import { getDb, getDeps } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { failure } from "../../../../../src/server/http";
import { createSignatureRequest, listingParties } from "../../../../../src/server/transaction-db";
import { appLink, audit, notifyUser, readJson, requireDocAccess } from "../../../../../src/server/transaction-http";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Body: { signers: [{ userId, roleLabel }] }. The OWNER sends the latest version of a document for e-signing. Signers must be the owner
 * or a buyer who enquired on the listing. The agent can prepare documents but cannot send them for signature.
 */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const a = await requireDocAccess(req, (await params).id);
  if (a instanceof NextResponse) return a;
  if (a.role !== "owner") return failure({ ok: false, code: "forbidden", message: "Only the owner can send a document for signing." });
  const body = await readJson(req);
  if (body instanceof NextResponse) return body;
  const parsed = parseSigners(body["signers"]);
  if (!parsed.ok) return NextResponse.json({ error: parsed.message }, { status: 400 });
  const db = getDb(), deps = getDeps();
  const parties = await listingParties(db, a.doc.listingId);
  const allowed = new Set([a.rec.listing.ownerUserId, ...parties.filter(p => p.role === "buyer").map(p => p.userId)].map(x => x.toLowerCase()));
  if (!parsed.signers.every(s => allowed.has(s.userId.toLowerCase()))) return NextResponse.json({ error: "Signers must be you or a buyer who has enquired on this listing." }, { status: 400 });
  const res = await createSignatureRequest(db, deps.newId(), a.doc, a.actor.userId, parsed.signers, expiryFrom(deps.now()));
  if (!res.ok) return NextResponse.json({ error: res.message }, { status: res.code === "conflict" ? 409 : 400 });
  await audit("signature.requested", "signature_request", res.request.id, a.actor.userId, { listingId: a.doc.listingId, documentId: a.doc.id, signers: parsed.signers.length });
  for (const s of parsed.signers) {
    if (s.userId.toLowerCase() === a.actor.userId.toLowerCase()) continue;
    await notifyUser(s.userId, "signature-request", "A document is waiting for your signature",
      `A document is waiting for you to read and sign.\nSign in to review it:${appLink(`/sign/${res.request.id}`)}\nThe request expires on ${new Date(res.request.expiresAt).toUTCString()}.`);
  }
  return NextResponse.json({ request: res.request }, { status: 201 });
}

export const POST = withApi(handlePost);
