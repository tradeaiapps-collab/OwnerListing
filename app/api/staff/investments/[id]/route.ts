import { NextResponse } from "next/server";
import { decideProject } from "../../../../../src/domain/investment-service";
import { REVIEW_OUTCOMES, type ReviewOutcome } from "../../../../../src/domain/investor-projects";
import { getInvestmentDeps } from "../../../../../src/server/investments-db";
import { investStaffGate, invFailure, notFound, ok, UUID, type Ctx } from "../../../../../src/server/investment-route";
import { fail, readJsonObject } from "../../../../../src/server/staff-route";

/** Staff decision: { outcome: approve | reject | request_changes, reason, version }. Reason and version go to the status history and audit. */
export async function POST(req: Request, { params }: Ctx) {
  const deps = getInvestmentDeps();
  const staff = await investStaffGate(req, deps, "investment.review");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID.test(id)) return notFound();
  const b = await readJsonObject(req);
  const outcome = b?.["outcome"];
  if (typeof outcome !== "string" || !(REVIEW_OUTCOMES as readonly string[]).includes(outcome)) return fail(400, "Choose approve, reject or request changes.");
  const r = await decideProject(deps, staff, id, outcome as ReviewOutcome, b?.["reason"], b?.["version"]);
  return r.ok ? ok({ status: r.value }) : invFailure(r);
}
