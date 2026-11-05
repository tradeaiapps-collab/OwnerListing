import { NextResponse } from "next/server";
import { getDb } from "../../../../../src/server/context";
import { MODERATION_ACTIONS, reviewModerationFlagPg, type ModerationAction } from "../../../../../src/server/message-moderation-db";
import { fail, readJsonObject, staffAudit, staffGate, UUID_RE } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Staff decision on a flagged message, once. Body: { "action": "approve" | "request_revision" | "educate", "note"?: text }. A note is required to request a revision or educate. */
async function handlePost(req: Request, { params }: Ctx) {
  const staff = await staffGate(req, "case.manage");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID_RE.test(id)) return fail(404, "Not found.");
  const b = await readJsonObject(req);
  const action = b?.["action"];
  const note = b?.["note"];
  if (typeof action !== "string" || !(MODERATION_ACTIONS as readonly string[]).includes(action)) return fail(400, "Action must be approve, request_revision or educate.");
  const clean = typeof note === "string" ? note.trim() : "";
  if (note !== undefined && (typeof note !== "string" || clean.length === 0 || note.length > 500)) return fail(400, "Note must be 1 to 500 characters.");
  if (action !== "approve" && !clean) return fail(400, "Add a note so the sender knows what to change.");
  if (!(await reviewModerationFlagPg(getDb(), id, staff.id, action as ModerationAction, clean || null, new Date().toISOString()))) return fail(409, "Already reviewed, or not found.");
  await staffAudit(staff, "message_moderation_flag", id, "moderation_flag.reviewed", { action });
  return NextResponse.json({ ok: true });
}

export const POST = withApi(handlePost);
