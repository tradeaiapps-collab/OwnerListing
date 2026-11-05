import { NextResponse } from "next/server";
import { analyseProposal, parseProposal } from "../../../../src/domain/feasibility";
import { getDb } from "../../../../src/server/context";
import { listHistoryPg, recentAnalysesPg, saveAnalysisPg } from "../../../../src/server/feasibility-db";
import { fail, readJsonObject, staffAudit, staffGateAny } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

const PERMS = ["report.operations", "report.sales"] as const;

/** Finished projects (the history Elena compares with) and the latest analyses. */
async function handleGet(req: Request) {
  const staff = await staffGateAny(req, PERMS);
  if (staff instanceof NextResponse) return staff;
  const db = getDb();
  return NextResponse.json({ history: await listHistoryPg(db), recent: await recentAnalysesPg(db) }, { headers: { "cache-control": "no-store" } });
}

/** Analyses a proposal against the team's history, stores the reading and returns it. Logged. */
async function handlePost(req: Request) {
  const staff = await staffGateAny(req, PERMS);
  if (staff instanceof NextResponse) return staff;
  const p = parseProposal(await readJsonObject(req));
  if (!p.ok) return fail(400, p.error);
  const db = getDb();
  const analysis = analyseProposal(p.value, await listHistoryPg(db));
  const id = await saveAnalysisPg(db, p.value, analysis, staff.id);
  await staffAudit(staff, "feasibility_analysis", id, "staff.feasibility_analysed", { points: analysis.points, probability: analysis.successProbability });
  return NextResponse.json({ id, analysis }, { status: 201 });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
