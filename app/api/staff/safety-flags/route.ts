import { NextResponse } from "next/server";
import { safetyQueuePg } from "../../../../src/server/ai-records-db";
import { getDb } from "../../../../src/server/context";
import { staffGate } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

/** Messages the safety filter sent for a person to check (high risk, or a mention of discrimination). Oldest first. */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "case.manage");
  if (staff instanceof NextResponse) return staff;
  return NextResponse.json({ flags: await safetyQueuePg(getDb()) }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
