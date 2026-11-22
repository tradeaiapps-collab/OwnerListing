import { NextResponse } from "next/server";
import { getActor } from "../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { withApi } from "../../../../../src/server/api/with-api";
import { getReportDeps } from "../../../../../src/server/agent-reports-db";
import { deleteReport, savedReport, updateReport } from "../../../../../src/domain/agent-reports";
import { reportResponse } from "../../../../../src/server/agent-report-response";

type Ctx = { params: Promise<{ id: string }> };

/** Run a saved report: ?format=json|csv|xlsx|pdf. JSON also returns its run history; add &snapshot=1 to store this run's totals in that history. */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const q = new URL(req.url).searchParams;
  const r = await savedReport(getReportDeps(), actor, (await params).id, q.get("snapshot") === "1");
  if (!r.ok) return failure(r);
  const format = q.get("format");
  if (format && format !== "json") return reportResponse(r.value.report, r.value.insights, format);
  return NextResponse.json(r.value, { headers: { "cache-control": "no-store" } });
}

/** Change a saved report: { name, definition, schedule?: { frequency } | null } (null stops the emails). */
async function handlePut(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await updateReport(getReportDeps(), actor, (await params).id, await req.json().catch(() => null));
  return r.ok ? NextResponse.json({ ok: true }) : failure(r);
}

async function handleDelete(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await deleteReport(getReportDeps(), actor, (await params).id);
  return r.ok ? NextResponse.json({ ok: true }) : failure(r);
}

export const GET = withApi(handleGet);
export const PUT = withApi(handlePut);
export const DELETE = withApi(handleDelete);
