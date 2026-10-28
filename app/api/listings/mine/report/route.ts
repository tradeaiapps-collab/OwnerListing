import { NextResponse } from "next/server";
import { forbiddenFor } from "../../../../../src/domain/access";
import { buildOwnerReport, ownerReportCsv } from "../../../../../src/domain/reports";
import { getActor, getDb } from "../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { loadOwnerReport } from "../../../../../src/server/reports-db";
import { withApi } from "../../../../../src/server/api/with-api";

/** The signed-in owner's own listings: enquiry and offer counts (page views are not tracked). CSV with ?format=csv. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const denied = forbiddenFor({ id: actor.userId, role: actor.userType }, "listing.create");
  if (denied) return failure(denied);
  const report = buildOwnerReport(await loadOwnerReport(getDb(), actor.userId));
  if (new URL(req.url).searchParams.get("format") !== "csv") return NextResponse.json({ report });
  return new NextResponse(ownerReportCsv(report), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="my-listings-report.csv"', "cache-control": "no-store" }
  });
}

export const GET = withApi(handleGet);
