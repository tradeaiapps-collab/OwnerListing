import { NextResponse } from "next/server";
import { KIND_LABELS, INSPECTION_KINDS, parseSchedule, summariseFindings } from "../../../../../src/domain/inspection";
import { getDb, getDeps } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { createInspection, findingsForInspections, inspectionsForListing, listingParties } from "../../../../../src/server/transaction-db";
import { audit, isHandler, readJson, requireTxnAccess, requireTxnHandler } from "../../../../../src/server/transaction-http";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Inspections on the listing. The owner and agent see all of them; an inspector or buyer sees only their own. */
async function handleGet(req: Request, { params }: Ctx) {
  const a = await requireTxnAccess(req, (await params).id);
  if (a instanceof NextResponse) return a;
  const db = getDb();
  const inspections = await inspectionsForListing(db, a.rec.listing.id, isHandler(a.role) ? { all: true } : { userId: a.actor.userId });
  const findings = await findingsForInspections(db, inspections.filter(i => i.status === "completed").map(i => i.id));
  return NextResponse.json({
    role: a.role, kinds: INSPECTION_KINDS.map(k => ({ id: k, label: KIND_LABELS[k] })),
    inspections: inspections.map(i => {
      const mine = findings.filter(f => f.inspectionId === i.id).map(({ inspectionId: _x, ...f }) => f);
      return { ...i, findings: mine, summary: i.status === "completed" ? summariseFindings(mine) : null };
    }),
    parties: isHandler(a.role) ? await listingParties(db, a.rec.listing.id) : []
  }, { headers: { "cache-control": "no-store" } });
}

/** Owner or appointed agent books an inspection or walkthrough. An inspector must confirm it; confirmation emails are queued. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const a = await requireTxnHandler(req, (await params).id);
  if (a instanceof NextResponse) return a;
  const body = await readJson(req);
  if (body instanceof NextResponse) return body;
  const deps = getDeps();
  const parsed = parseSchedule(body, deps.now());
  if (!parsed.ok) return NextResponse.json({ error: parsed.errors[0], errors: parsed.errors }, { status: 400 });
  const res = await createInspection(getDb(), deps.newId(), a.rec.listing.id, a.actor.userId, parsed.value, a.rec.listing.ownerUserId, deps.now());
  if (!res.ok) return NextResponse.json({ error: res.message }, { status: res.code === "conflict" ? 409 : 400 });
  await audit("inspection.scheduled", "inspection", res.inspection.id, a.actor.userId, { listingId: a.rec.listing.id, kind: res.inspection.kind, byAgent: a.role === "agent" });
  return NextResponse.json({ inspection: res.inspection }, { status: 201 });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
