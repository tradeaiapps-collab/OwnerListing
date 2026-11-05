import { NextResponse } from "next/server";
import { cancelWithProvider, docusignSigningLink, refreshFromDocusign, retryDocument, sendViaDocusign } from "../../../../src/domain/esign-service";
import { declineDocument, explainClause, sendDocument, signDocument, viewDocument } from "../../../../src/domain/signing-service";
import { getActor } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../src/server/http";
import { getEsignDeps, signingMode } from "../../../../src/server/esign";
import { getSigningRepo, requestContext, signingIds, signingPersona } from "../../../../src/server/signing-db";
import { withApi } from "../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** The document, who has signed, and the audit trail. Only the owner and the signers (once it is sent) can read it; anyone else gets 404. */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const r = await viewDocument(getSigningRepo(), actor, id, signingIds, requestContext(req));
  return r.ok ? NextResponse.json({ ...r.value, artifacts: await getSigningRepo().artifacts(id), persona: await signingPersona() }) : failure(r);
}

/**
 * Body: { "action": "send" | "cancel" | "retry" } for the owner ("retry" copies a declined or cancelled document into a new draft), { "action": "refresh" }
 * for the owner or a signer (asks DocuSign for the latest status), { "action": "docusign_link" } for a signer (returns the DocuSign signing page address), or { "action": "explain", "clauseId" }, { "action": "sign", "typedName", "consent": true }
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
    case "send": {
      const doc = await repo.document(id);
      if (doc?.provider === "docusign") {
        const deps = getEsignDeps();
        if (!deps) return NextResponse.json({ error: "DocuSign is not set up yet." }, { status: 503 });
        const r = await sendViaDocusign(deps, actor, id, ctx);
        return r.ok ? NextResponse.json({ document: r.value }) : failure(r);
      }
      const r = await sendDocument(repo, actor, id, signingIds, ctx);
      return r.ok ? NextResponse.json({ document: r.value }) : failure(r);
    }
    case "cancel": { const r = await cancelWithProvider(getEsignDeps(), repo, actor, id, signingIds, ctx); return r.ok ? NextResponse.json({ document: r.value }) : failure(r); }
    case "retry": {
      if (signingMode() === "docusign" && !getEsignDeps()) return NextResponse.json({ error: "DocuSign is not set up yet." }, { status: 503 });
      const r = await retryDocument(repo, actor, id, signingIds, signingMode(), ctx);
      return r.ok ? NextResponse.json({ document: r.value }, { status: 201 }) : failure(r);
    }
    case "docusign_link": {
      const deps = getEsignDeps();
      if (!deps) return NextResponse.json({ error: "DocuSign is not set up yet." }, { status: 503 });
      const r = await docusignSigningLink(deps, actor, id, ctx);
      return r.ok ? NextResponse.json(r.value) : failure(r);
    }
    case "refresh": {
      const deps = getEsignDeps();
      if (!deps) return NextResponse.json({ error: "DocuSign is not set up yet." }, { status: 503 });
      const r = await refreshFromDocusign(deps, actor, id);
      return r.ok ? NextResponse.json({ document: r.value }) : failure(r);
    }
    case "explain": { const r = await explainClause(repo, actor, id, (body as Record<string, unknown>)["clauseId"], signingIds, ctx); return r.ok ? NextResponse.json(r.value) : failure(r); }
    case "sign": { const r = await signDocument(repo, actor, id, body, signingIds, ctx); return r.ok ? NextResponse.json({ document: r.value }) : failure(r); }
    case "decline": { const r = await declineDocument(repo, actor, id, body, signingIds, ctx); return r.ok ? NextResponse.json({ document: r.value }) : failure(r); }
    default: return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
