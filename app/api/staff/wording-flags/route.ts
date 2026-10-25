import { NextResponse } from "next/server";
import { getDb } from "../../../../src/server/context";
import { staffAudit, staffGate } from "../../../../src/server/staff-route";
import { listWordingFlagsPg, WORDING_FLAG_STATUSES, type WordingFlagStatus } from "../../../../src/server/wording-flags-db";

/** Wording the anti-discrimination filter blocked at publish. ?status=open (default), cleared or upheld. */
export async function GET(req: Request) {
  const staff = await staffGate(req, "wording.review");
  if (staff instanceof NextResponse) return staff;
  const s = new URL(req.url).searchParams.get("status") ?? "open";
  const status = WORDING_FLAG_STATUSES.find(x => x === s) as WordingFlagStatus | undefined;
  if (!status) return NextResponse.json({ error: "Unknown status." }, { status: 400 });
  const flags = await listWordingFlagsPg(getDb(), status);
  await staffAudit(staff, "staff_session", staff.id, "staff.wording_flags_viewed", { status, returned: flags.length });
  return NextResponse.json({ flags }, { headers: { "cache-control": "no-store" } });
}
