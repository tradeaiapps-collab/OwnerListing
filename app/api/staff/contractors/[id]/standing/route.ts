import { NextResponse } from "next/server";
import { parseSuspension } from "../../../../../../src/domain/contractor-trust";
import { getDb } from "../../../../../../src/server/context";
import { setSuspensionPg } from "../../../../../../src/server/contractor-trust-db";
import { fail, readJsonObject, staffGate, UUID_RE } from "../../../../../../src/server/staff-route";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** { "action": "suspend" | "reinstate", "note": text }. A suspended contractor cannot be invited, accept jobs or appear in automatic matching. */
async function handlePost(req: Request, { params }: Ctx) {
  const staff = await staffGate(req, "moderation.review");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID_RE.test(id)) return fail(404, "Not found.");
  const d = parseSuspension(await readJsonObject(req));
  if (!d.ok) return fail(400, d.message);
  if (!(await setSuspensionPg(getDb(), staff.id, id, d.value.action === "suspend", d.value.note))) return fail(409, "No change: already in that state, not a contractor account, or your own account.");
  return NextResponse.json({ ok: true });
}

export const POST = withApi(handlePost);
