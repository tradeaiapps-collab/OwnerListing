import { NextResponse } from "next/server";
import { getDb } from "../../../../src/server/context";
import { moderationQueuePg } from "../../../../src/server/message-moderation-db";
import { staffGate } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

/** Flagged seller-side messages. ?status=reviewed lists decided ones. Highest severity first. */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "case.manage");
  if (staff instanceof NextResponse) return staff;
  const status = new URL(req.url).searchParams.get("status") === "reviewed" ? "reviewed" : "open";
  return NextResponse.json({ flags: await moderationQueuePg(getDb(), status) }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
