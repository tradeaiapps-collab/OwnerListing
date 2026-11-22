import { NextResponse } from "next/server";
import { TEMPLATE_LABEL, renderTemplate, templateById, templatesFor } from "../../../../../src/domain/document-templates";
import { getDb, getDeps } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { addGenerated, cancelRequest, generatedById, requestsForDocument } from "../../../../../src/server/transaction-db";
import { audit, readJson, requireTxnHandler, UUID_RE } from "../../../../../src/server/transaction-http";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Templates that fit this listing (sale or rent), with the fields the listing can fill in. Owner or appointed agent only. */
async function handleGet(req: Request, { params }: Ctx) {
  const a = await requireTxnHandler(req, (await params).id);
  if (a instanceof NextResponse) return a;
  const l = a.rec.listing;
  const prefill = { address: l.address, state: l.jurisdiction, title: l.title };
  return NextResponse.json({
    label: TEMPLATE_LABEL,
    templates: templatesFor(l.transactionType).map(t => ({
      id: t.id, title: t.title, summary: t.summary, version: t.version, signerRoles: t.signerRoles,
      fields: t.fields.map(f => ({ key: f.key, label: f.label, required: f.required, maxLength: f.maxLength, multiline: f.multiline === true, value: f.prefill ? prefill[f.prefill] : "" }))
    }))
  }, { headers: { "cache-control": "no-store" } });
}

/**
 * Body: { templateId, fields, supersedesId? }. Makes a document from a template. With supersedesId it becomes the next version of that
 * document (the old one is kept; an open signing request on the old version is cancelled). Nothing is sent or signed here.
 */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const a = await requireTxnHandler(req, (await params).id);
  if (a instanceof NextResponse) return a;
  const body = await readJson(req, 30_000);
  if (body instanceof NextResponse) return body;
  const t = typeof body["templateId"] === "string" ? templateById(body["templateId"]) : undefined;
  const l = a.rec.listing;
  if (!t || (t.transaction !== "both" && t.transaction !== l.transactionType)) return NextResponse.json({ error: "Choose a template." }, { status: 400 });
  const r = renderTemplate(t, body["fields"], { state: l.jurisdiction });
  if (!r.ok) return NextResponse.json({ error: "Check the highlighted fields.", fields: r.errors }, { status: 400 });
  const db = getDb(), deps = getDeps();
  let prev;
  if (body["supersedesId"] !== undefined) {
    prev = typeof body["supersedesId"] === "string" && UUID_RE.test(body["supersedesId"]) ? await generatedById(db, body["supersedesId"]) : undefined;
    if (!prev || prev.listingId !== l.id || prev.templateId !== t.id) return NextResponse.json({ error: "The document to replace was not found." }, { status: 404 });
    for (const rq of await requestsForDocument(db, prev.id)) if (rq.status === "pending") await cancelRequest(db, rq.id, a.actor.userId, deps.now());
  }
  const res = await addGenerated(db, { id: deps.newId(), listingId: l.id, templateId: t.id, templateVersion: t.version, supersedes: prev, title: r.value.title, body: r.value.body, fields: r.value.fields, contentSha256: r.value.contentSha256, createdBy: a.actor.userId });
  if (!res.ok) return NextResponse.json({ error: res.message }, { status: 409 });
  await audit(prev ? "document.version_created" : "document.created", "generated_document", res.doc.id, a.actor.userId, { listingId: l.id, templateId: t.id, version: res.doc.version });
  return NextResponse.json({ document: { id: res.doc.id, version: res.doc.version } }, { status: 201 });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
