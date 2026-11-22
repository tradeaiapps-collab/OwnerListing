import { NextResponse } from "next/server";
import { isAppointedAgent } from "../domain/appointed-agent";
import type { Actor, ListingRecord } from "../domain/listing-service";
import type { Viewer } from "../domain/transaction-assistant";
import { appOriginFor, readAppMode } from "../config/app-mode";
import { getActor, getDeps, getDb } from "./context";
import { failure, unauthenticated } from "./http";
import { getEmailPort } from "./messaging";
import { generatedById, isListingInspector, isListingParty, requestsForDocument, signersFor, type GeneratedDoc } from "./transaction-db";

export interface TxnAccess { actor: Actor; rec: ListingRecord; role: Viewer }
const notFound = { ok: false, code: "not_found", message: "Listing not found." } as const;
export const isHandler = (r: Viewer): boolean => r === "owner" || r === "agent";
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Who is asking about this listing's inspections and documents: the owner, its appointed agent, an inspector assigned to it, or a buyer
 * who has enquired on it. Everyone else (and a missing listing) gets 404 so nothing about the listing is revealed.
 */
export async function requireTxnAccess(req: Request, listingId: string): Promise<TxnAccess | NextResponse> {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (!UUID_RE.test(listingId)) return failure(notFound);
  const deps = getDeps();
  const rec = await deps.repo.get(listingId);
  if (!rec) return failure(notFound);
  if (actor.userId === rec.listing.ownerUserId) return { actor, rec, role: "owner" };
  if (await isAppointedAgent(deps, actor, rec.listing)) return { actor, rec, role: "agent" };
  const db = getDb();
  if (await isListingInspector(db, listingId, actor.userId)) return { actor, rec, role: "inspector" };
  if (actor.userType === "buyer" && await isListingParty(db, listingId, actor.userId)) return { actor, rec, role: "buyer" };
  return failure(notFound);
}

/** Same as requireTxnAccess but only the owner or appointed agent pass; others get 404. */
export async function requireTxnHandler(req: Request, listingId: string): Promise<TxnAccess | NextResponse> {
  const a = await requireTxnAccess(req, listingId);
  return a instanceof NextResponse ? a : isHandler(a.role) ? a : failure(notFound);
}

export async function readJson(req: Request, max = 20_000): Promise<Record<string, unknown> | NextResponse> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > max) return NextResponse.json({ error: "The request is too large." }, { status: 413 });
  const raw = await req.text().catch(() => "");
  if (raw.length > max) return NextResponse.json({ error: "The request is too large." }, { status: 413 });
  try {
    const v: unknown = JSON.parse(raw);
    if (v !== null && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch { /* falls through */ }
  return NextResponse.json({ error: "Send a JSON object." }, { status: 400 });
}

export async function audit(type: string, aggregateType: string, aggregateId: string, actorId: string, payload: Record<string, unknown>): Promise<void> {
  const deps = getDeps();
  await deps.appendAudit({ id: deps.newId(), occurredAt: deps.now(), actorType: "user", actorId, aggregateType, aggregateId, eventType: type, correlationId: deps.newId(), payload });
}

/** Plain email through the messaging outbox. Never blocks the action: a missing address or unconfigured email is skipped quietly. */
export async function notifyUser(userId: string, template: string, subject: string, text: string): Promise<void> {
  try {
    const db = getDb();
    const port = await getEmailPort(db, process.env, template);
    if (!port.configured) return;
    const r = await db.query("SELECT email FROM app_user WHERE id = $1 AND status = 'active' AND email IS NOT NULL", [userId]);
    const to = r.rows[0]?.["email"];
    if (typeof to === "string") await port.send({ to, subject, text });
  } catch { /* a notice never blocks the action */ }
}

export const appLink = (path: string): string => {
  const origin = appOriginFor(readAppMode());
  return origin ? ` ${origin}${path}` : "";
};

export interface DocAccess extends TxnAccess { doc: GeneratedDoc; isSigner: boolean }

/** A template document: the owner or agent of its listing, or someone asked to sign it. Anyone else gets 404. */
export async function requireDocAccess(req: Request, docId: string): Promise<DocAccess | NextResponse> {
  const doc = UUID_RE.test(docId) ? await generatedById(getDb(), docId) : undefined;
  if (!doc) return failure({ ok: false, code: "not_found", message: "Document not found." });
  const a = await requireTxnAccess(req, doc.listingId);
  if (a instanceof NextResponse) return a;
  let isSigner = false;
  for (const r of await requestsForDocument(getDb(), doc.id)) {
    if ((await signersFor(getDb(), r.id)).some(s => s.userId === a.actor.userId)) { isSigner = true; break; }
  }
  if (!isHandler(a.role) && !isSigner) return failure({ ok: false, code: "not_found", message: "Document not found." });
  return { ...a, doc, isSigner };
}
