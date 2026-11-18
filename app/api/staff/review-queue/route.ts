import { NextResponse } from "next/server";
import { staffCan } from "../../../../src/domain/staff-access";
import { decisionsFor, isSubjectType } from "../../../../src/domain/moderation-queue";
import { getDb } from "../../../../src/server/context";
import { listQueuePg, queueCountsPg, type QueueView } from "../../../../src/server/moderation-queue-db";
import { staffGate } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

const VIEWS: readonly QueueView[] = ["open", "escalated", "decided"];

/** The review queue. ?view=open (default) | escalated | decided, optional ?type=listing|message|profile. Each item carries its decision history. */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "moderation.review");
  if (staff instanceof NextResponse) return staff;
  const sp = new URL(req.url).searchParams;
  const view = VIEWS.find(v => v === (sp.get("view") ?? "open"));
  if (!view) return NextResponse.json({ error: "Unknown view." }, { status: 400 });
  const type = sp.get("type");
  if (type && !isSubjectType(type)) return NextResponse.json({ error: "Unknown type." }, { status: 400 });
  const db = getDb();
  const [items, counts] = await Promise.all([listQueuePg(db, { view, ...(type && isSubjectType(type) ? { subjectType: type } : {}) }), queueCountsPg(db)]);
  const decisions = { open: decisionsFor(staff, "open"), escalated: decisionsFor(staff, "escalated") };
  const canSuspend = { listing: staffCan(staff, "listing.moderate"), account: staffCan(staff, "user.manage") };
  return NextResponse.json({ items, counts, me: staff.id, decisions, canSuspend }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
