import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { parseScoringConfig, DEFAULT_SCORING } from "../../../../src/domain/lead-scoring";
import { staffCan } from "../../../../src/domain/staff-access";
import { loadScoringConfig } from "../../../../src/server/agent-workspace-db";
import { getDb, getStaff } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { appendAuditPg } from "../../../../src/server/db";
import { withApi } from "../../../../src/server/api/with-api";

const NO_STORE = { "cache-control": "no-store" };

/** Lead scoring rules: hot/warm thresholds and the blend of engagement, property fit and follow-up timing. Needs feeds.manage. */
async function handleGet(req: Request) {
  const staff = await getStaff(req);
  if (!staff) return NextResponse.json({ error: "Sign in as staff." }, { status: 401 });
  if (!staffCan(staff, "feeds.manage")) return NextResponse.json({ error: "Not allowed." }, { status: 403 });
  return NextResponse.json({ config: await loadScoringConfig(getDb()), defaults: DEFAULT_SCORING }, { headers: NO_STORE });
}

async function handlePut(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const staff = await getStaff(req);
  if (!staff) return NextResponse.json({ error: "Sign in as staff." }, { status: 401 });
  if (!staffCan(staff, "feeds.manage")) return NextResponse.json({ error: "Not allowed." }, { status: 403 });
  const p = parseScoringConfig(await req.json().catch(() => null));
  if (!p.ok) return NextResponse.json({ error: p.message }, { status: 400 });
  const c = p.value, db = getDb(), now = new Date().toISOString();
  const before = await loadScoringConfig(db);
  await db.query(
    `UPDATE lead_scoring_setting SET hot_min=$1, warm_min=$2, w_engagement=$3, w_fit=$4, w_follow_up=$5, updated_by=$6::uuid, updated_at=$7::timestamptz WHERE id = 1`,
    [c.hotMin, c.warmMin, c.weights.engagement, c.weights.fit, c.weights.followUp, staff.id, now]);
  await appendAuditPg(db, { id: randomUUID(), occurredAt: now, actorType: "user", actorId: staff.id, aggregateType: "lead_scoring", aggregateId: "1",
    eventType: "lead_scoring.updated", correlationId: randomUUID(), payload: { before, after: c } });
  return NextResponse.json({ config: c });
}

export const GET = withApi(handleGet);
export const PUT = withApi(handlePut);
