import { NextResponse } from "next/server";
import { ESIGN_CONSENT_TEXT, ESIGN_CONSENT_VERSION } from "../../../../src/domain/e-sign";
import { getDb, getDeps } from "../../../../src/server/context";
import { expireIfDue, isSuperseded, markViewed, requestsForDocument, signersFor } from "../../../../src/server/transaction-db";
import { isHandler, requireDocAccess } from "../../../../src/server/transaction-http";
import { withApi } from "../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/**
 * One template document with its signing requests. The owner and agent see everything. A signer sees the document and the
 * state of its requests; opening it as a pending signer is recorded once in the document's history.
 */
async function handleGet(req: Request, { params }: Ctx) {
  const a = await requireDocAccess(req, (await params).id);
  if (a instanceof NextResponse) return a;
  const db = getDb(), now = getDeps().now();
  const requests = [];
  for (const r0 of await requestsForDocument(db, a.doc.id)) {
    await expireIfDue(db, r0.id, now);
    const signers = await signersFor(db, r0.id);
    const me = signers.find(s => s.userId === a.actor.userId);
    if (me?.status === "pending") await markViewed(db, r0.id, a.actor.userId, now);
    const status = r0.status === "pending" && Date.parse(r0.expiresAt) <= Date.parse(now) ? "expired" : r0.status;
    requests.push({
      id: r0.id, status, expiresAt: r0.expiresAt, createdAt: r0.createdAt, closedAt: r0.closedAt ?? null,
      mine: me ? { status: me.status, roleLabel: me.roleLabel } : null,
      signers: signers.map(s => ({ name: s.name, roleLabel: s.roleLabel, status: s.status, signedAt: s.signedAt ?? null, typedName: s.typedName ?? null, evidenceSha256: s.evidenceSha256 ?? null, declineReason: isHandler(a.role) ? (s.declineReason ?? null) : null }))
    });
  }
  const d = a.doc;
  return NextResponse.json({
    role: a.role, consent: { version: ESIGN_CONSENT_VERSION, text: ESIGN_CONSENT_TEXT },
    document: { id: d.id, listingId: d.listingId, templateId: d.templateId, version: d.version, title: d.title, body: d.body, contentSha256: d.contentSha256, createdAt: d.createdAt, latest: !(await isSuperseded(db, d.id)), fields: isHandler(a.role) ? d.fields : undefined },
    requests
  }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
