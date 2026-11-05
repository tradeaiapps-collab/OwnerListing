import { NextResponse } from "next/server";
import { getActor } from "../../../../src/server/context";
import { failure, unauthenticated } from "../../../../src/server/http";
import { withApi } from "../../../../src/server/api/with-api";
import { getReportDeps } from "../../../../src/server/agent-reports-db";
import { listReports, saveReport, GROUPS, METRICS, PERIOD_DAYS, TEMPLATES } from "../../../../src/domain/agent-reports";

/** The signed-in agent's saved reports with their schedules, plus the template and metric catalogue the builder offers. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await listReports(getReportDeps(), actor);
  if (!r.ok) return failure(r);
  const templates = Object.entries(TEMPLATES).map(([key, t]) => ({ key, label: t.label, blurb: t.blurb, metrics: t.metrics, groupBy: t.groupBy, days: t.days }));
  return NextResponse.json({ ...r.value, templates, metrics: METRICS, groups: GROUPS, periodDays: PERIOD_DAYS }, { headers: { "cache-control": "no-store" } });
}

/** Save a report: { name, definition, schedule?: { frequency: "daily" | "weekly" | "monthly" } }. Scheduled reports are emailed to the agent's own address. */
async function handlePost(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await saveReport(getReportDeps(), actor, await req.json().catch(() => null));
  return r.ok ? NextResponse.json(r.value, { status: 201 }) : failure(r);
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
