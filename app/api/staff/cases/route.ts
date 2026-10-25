import { NextResponse } from "next/server";
import { getDb } from "../../../../src/server/context";
import { listCases } from "../../../../src/server/staff-admin-db";
import { fail, staffGate } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

const STATUSES = ["active", "open", "in_progress", "resolved"] as const;

/** Admin case queue. Unresolved cases by default. */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "case.manage");
  if (staff instanceof NextResponse) return staff;
  const status = new URL(req.url).searchParams.get("status") ?? "active";
  if (!(STATUSES as readonly string[]).includes(status)) return fail(400, "Unknown status.");
  return NextResponse.json({ cases: await listCases(getDb(), status as (typeof STATUSES)[number]), me: staff.id });
}

export const GET = withApi(handleGet);
