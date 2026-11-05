import { NextResponse } from "next/server";
import { cancelDocument, declineDocument, explainClause, sendDocument, signDocument, viewDocument } from "../../../../src/domain/signing-service";
import { csrfGuard } from "../../../../src/server/csrf";
import { SIGN_ATTEMPT_RATE } from "../../../../src/domain/rate-limit";
import { getActor, getDb } from "../../../../src/server/context";
import { withinRates } from "../../../../src/server/rate-guard";
import { failure, unauthenticated } from "../../../../src/server/http";
import { getSigningRepo, requestContext, signingIds, signingPersona } from "../../../../src/server/signing-db";
import { withApi } from "../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** The document, who has signed, and the audit trail. Only the owner and the signers (once it is sent) can read it; anyone else gets 404. */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const r = await viewDocument(getSigningRepo(), actor, id, signingIds, requestContext(req));
  return r.ok ? NextResponse.json({ ...r.value, persona: await signingPersona() }) : failure(r);
}

/**
 * Body: { "action": "send" | "cancel" } for the owner, or { "action": "explain", "clauseId" }, { "action": "sign", "typedName", "consent": true }
 * and { "action": "decline", "reason"? } for a signer.
 */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const body: unknown = await req.json().catch(() => null);
  const action = body !== null && typeof body === "object" ? (body as Record<string, unknown>)["action"] : undefined;
  const repo = getSigningRepo();
  const ctx = requestContext(req);
  switch (action) {
    case "send": { const r = await sendDocument(repo, actor, id, signingIds, ctx); return r.ok ? NextResponse.json({ document: r.value }) : failure(r); }
    case "cancel": { const r = await cancelDocument(repo, actor, id, signingIds, ctx); return r.ok ? NextResponse.json({ document: r.value }) : failure(r); }
    case "explain": { const r = await explainClause(repo, actor, id, (body as Record<string, unknown>)["clauseId"], signingIds, ctx); return r.ok ? NextResponse.json(r.value) : failure(r); }
    case "sign": {
      if (!(await withinRates(getDb(), "sign-attempt-user", [actor.userId], { windowMs: SIGN_ATTEMPT_RATE.windowMs, limit: SIGN_ATTEMPT_RATE.perUser })))
        return NextResponse.json({ error: "Too many signing attempts. Wait 15 minutes and try again." }, { status: 429, headers: { "retry-after": "900" } });
      const r = await signDocument(repo, actor, id, body, signingIds, ctx); return r.ok ? NextResponse.json({ document: r.value }) : failure(r); }
    case "decline": { const r = await declineDocument(repo, actor, id, body, signingIds, ctx); return r.ok ? NextResponse.json({ document: r.value }) : failure(r); }
    default: return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
