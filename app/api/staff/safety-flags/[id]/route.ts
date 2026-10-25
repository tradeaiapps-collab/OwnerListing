import { NextResponse } from "next/server";
import { reviewSafetyFlagPg } from "../../../../../src/server/ai-records-db";
import { getDb } from "../../../../../src/server/context";
import { fail, readJsonObject, staffAudit, staffGate, UUID_RE } from "../../../../../src/server/staff-route";

type Ctx = { params: Promise<{ id: string }> };

/** Staff record whether a flagged message was a real problem. Body: { "outcome": "confirmed" | "dismissed", "note"?: text }. Once only. */
export async function POST(req: Request, { params }: Ctx) {
  const staff = await staffGate(req, "case.manage");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID_RE.test(id)) return fail(404, "Not found.");
  const b = await readJsonObject(req);
  const outcome = b?.["outcome"];
  const note = b?.["note"];
  if (outcome !== "confirmed" && outcome !== "dismissed") return fail(400, "Outcome must be confirmed or dismissed.");
  if (note !== undefined && (typeof note !== "string" || note.trim().length === 0 || note.length > 500)) return fail(400, "Note must be 1 to 500 characters.");
  if (!(await reviewSafetyFlagPg(getDb(), id, staff.id, outcome, typeof note === "string" ? note.trim() : null, new Date().toISOString()))) {
    return fail(409, "Already reviewed, or not found.");
  }
  await staffAudit(staff, "message_safety_flag", id, "safety_flag.reviewed", { outcome });
  return NextResponse.json({ ok: true });
}
