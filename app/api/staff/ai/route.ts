import { NextResponse } from "next/server";
import { REASON_ERROR, reasonOk } from "../../../../src/domain/staff-admin";
import { aiAdminGate, aiAdminView } from "../../../../src/server/ai-admin";
import { setAiSwitch } from "../../../../src/server/ai-switch-db";
import { getDb } from "../../../../src/server/context";
import { fail, readJsonObject, staffAudit } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

const NO_STORE = { "cache-control": "no-store" };

/** AI switch and engine config (super admin only). */
async function handleGet(req: Request) {
  const staff = await aiAdminGate(req);
  if (staff instanceof NextResponse) return staff;
  return NextResponse.json(await aiAdminView(), { headers: NO_STORE });
}

/** Turns AI on or off. Body: { enabled: boolean, reason: string (10+ characters) }. Adds a history row and an audit event. */
async function handlePost(req: Request) {
  const staff = await aiAdminGate(req);
  if (staff instanceof NextResponse) return staff;
  const body = await readJsonObject(req);
  const enabled = body?.["enabled"];
  const reason = body?.["reason"];
  if (typeof enabled !== "boolean") return fail(400, "Send enabled as true or false.");
  if (!reasonOk(reason) || reason.trim().length > 300) return fail(400, `${REASON_ERROR} At most 300 characters.`);
  await setAiSwitch(getDb(), staff, enabled, reason);
  await staffAudit(staff, "ai_switch", "site", enabled ? "ai.switched_on" : "ai.switched_off", { enabled });
  return NextResponse.json(await aiAdminView(), { headers: NO_STORE });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
