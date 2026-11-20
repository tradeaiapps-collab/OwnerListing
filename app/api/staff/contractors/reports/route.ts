import { NextResponse } from "next/server";
import { getDb } from "../../../../../src/server/context";
import { listReportsPg } from "../../../../../src/server/contractor-trust-db";
import { staffGate } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";

/** Owner reports about contractors. ?view=decided lists reviewed ones. */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "moderation.review");
  if (staff instanceof NextResponse) return staff;
  const view = new URL(req.url).searchParams.get("view") === "decided" ? "decided" : "open";
  return NextResponse.json({ reports: await listReportsPg(getDb(), view) }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
