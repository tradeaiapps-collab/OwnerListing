import { NextResponse } from "next/server";
import { templateById } from "../../../../../src/domain/document-templates";
import { getDb } from "../../../../../src/server/context";
import { generatedForListing, requestsForListing, signersFor } from "../../../../../src/server/transaction-db";
import { isHandler, requireTxnAccess } from "../../../../../src/server/transaction-http";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Documents made from templates on this listing, with where each stands (draft, out for signing, signed).
 * The owner and agent see all; anyone else sees only documents they have been asked to sign.
 */
async function handleGet(req: Request, { params }: Ctx) {
  const a = await requireTxnAccess(req, (await params).id);
  if (a instanceof NextResponse) return a;
  const db = getDb();
  const [docs, reqs] = await Promise.all([generatedForListing(db, a.rec.listing.id), requestsForListing(db, a.rec.listing.id)]);
  const signers = new Map(await Promise.all(reqs.map(async r => [r.id, await signersFor(db, r.id)] as const)));
  const superseded = new Set(docs.map(d => d.supersedesId).filter((x): x is string => !!x));
  const rows = docs.map(d => {
    const rs = reqs.filter(r => r.documentId === d.id);
    const mine = rs.some(r => signers.get(r.id)?.some(s => s.userId === a.actor.userId));
    const open = rs.find(r => r.status === "pending");
    const done = rs.find(r => r.status === "completed");
    return {
      openRequestId: open && signers.get(open.id)?.some(s => s.userId === a.actor.userId && s.status === "pending") ? open.id : null,
      id: d.id, title: d.title, templateId: d.templateId, version: d.version, createdAt: d.createdAt, latest: !superseded.has(d.id), mine,
      state: done ? "signed" : open ? "awaiting_signature" : rs.some(r => r.status === "declined") ? "declined" : "draft",
      signers: open || done ? (signers.get((open ?? done)!.id) ?? []).map(s => ({ name: s.name, roleLabel: s.roleLabel, status: s.status })) : [],
      signerRoles: templateById(d.templateId)?.signerRoles ?? []
    };
  }).filter(d => isHandler(a.role) || d.mine);
  return NextResponse.json({ role: a.role, documents: rows }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
