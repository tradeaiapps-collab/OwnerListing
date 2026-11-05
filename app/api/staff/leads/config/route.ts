import { NextResponse } from "next/server";
import { activateConfig, proposeConfig } from "../../../../../src/domain/lead-service";
import { getLeadDeps } from "../../../../../src/server/lead-db";
import { failure } from "../../../../../src/server/http";
import { fail, readJsonObject, staffGate } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";

/** The active scoring config (weights and question order). Needs the sales report permission. */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "report.sales");
  if (staff instanceof NextResponse) return staff;
  return NextResponse.json({ config: await (await getLeadDeps()).repo.activeConfig() }, { headers: { "cache-control": "no-store" } });
}

/** Body: { "action": "propose" } learns a new version from agent results (saved inactive); { "action": "activate", "version": n } switches to it. Needs user.manage. */
async function handlePost(req: Request) {
  const staff = await staffGate(req, "user.manage");
  if (staff instanceof NextResponse) return staff;
  const b = await readJsonObject(req);
  if (!b) return fail(400, "Send a JSON object.");
  const d = await getLeadDeps();
  const r = b["action"] === "propose" ? await proposeConfig(d, staff.id)
    : b["action"] === "activate" ? await activateConfig(d, staff.id, b["version"])
    : ({ ok: false, code: "invalid", message: "Unknown action." } as const);
  return r.ok ? NextResponse.json(r.value) : failure(r);
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
