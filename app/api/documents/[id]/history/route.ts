import { NextResponse } from "next/server";
import { canViewDocument } from "../../../../../src/domain/documents";
import { getActor, getDb, getDeps } from "../../../../../src/server/context";
import { createPgDocumentStore } from "../../../../../src/server/documents-db";
import { failure } from "../../../../../src/server/http";
import { uploadedHistory } from "../../../../../src/server/transaction-db";
import { UUID_RE } from "../../../../../src/server/transaction-http";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/**
 * History of an uploaded file: each version and every recorded download. Only people who can open the file can see its history
 * (same rule as the download); the owner sees all versions, everyone else only the active one's chain without uploader names.
 */
async function handleGet(req: Request, { params }: Ctx) {
  const { id } = await params;
  const notFound = () => failure({ ok: false, code: "not_found", message: "File not found." });
  if (!UUID_RE.test(id)) return notFound();
  const actor = await getActor(req);
  const db = getDb(), store = createPgDocumentStore(db);
  const doc = await store.documentById(id);
  const rec = doc ? await getDeps().repo.get(doc.listingId) : undefined;
  if (!doc || !rec) return notFound();
  const isOwner = actor !== null && actor.userId === doc.ownerUserId;
  const assignments = actor && !isOwner ? await store.assignmentsFor(doc.listingId, actor.userId) : [];
  if (!canViewDocument(actor?.userId, doc, rec.listing.status === "published", assignments) || (!isOwner && doc.status !== "active")) return notFound();
  const entries = await uploadedHistory(db, id);
  return NextResponse.json({ entries: isOwner ? entries : entries.filter(e => e.type !== "downloaded").map(e => ({ ...e, actorName: undefined })) }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
