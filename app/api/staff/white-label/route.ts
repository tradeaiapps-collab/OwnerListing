import { NextResponse } from "next/server";
import { TENANT_STATUSES, type TenantStatus } from "../../../../src/domain/white-label";
import { getDb } from "../../../../src/server/context";
import { NO_STORE } from "../../../../src/server/site-route";
import { UUID_RE, fail, readJsonObject, staffGate } from "../../../../src/server/staff-route";
import { clearTenantCache } from "../../../../src/server/white-label";
import { listTenants, setStatus } from "../../../../src/server/white-label-db";
import { withApi } from "../../../../src/server/api/with-api";

/** Platform staff (theme.edit) review agency brands. GET lists them (drafts first). POST { tenantId, status: "active" | "suspended" | "draft", note? } decides one. */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "theme.edit");
  if (staff instanceof NextResponse) return staff;
  const tenants = await listTenants(getDb());
  return NextResponse.json({
    tenants: tenants.map(t => ({
      id: t.id, teamName: t.teamName, status: t.status, name: t.settings.brand.siteName, tagline: t.settings.brand.tagline,
      primary: t.settings.colours.light.primary, secondary: t.settings.colours.light.secondary, hasLogo: t.logoLightId !== null,
      updatedAt: t.updatedAt, reviewedAt: t.reviewedAt, domains: t.domains.map(d => ({ host: d.host, verified: d.verifiedAt !== null }))
    }))
  }, { headers: NO_STORE });
}

async function handlePost(req: Request) {
  const staff = await staffGate(req, "theme.edit");
  if (staff instanceof NextResponse) return staff;
  const body = await readJsonObject(req);
  if (!body) return fail(400, "Send a JSON object.");
  const id = body["tenantId"], status = body["status"];
  if (typeof id !== "string" || !UUID_RE.test(id)) return fail(400, "Send a valid tenantId.");
  if (typeof status !== "string" || !(TENANT_STATUSES as readonly string[]).includes(status)) return fail(400, "status must be active, suspended or draft.");
  const note = typeof body["note"] === "string" ? body["note"] : "";
  const r = await setStatus(getDb(), staff.id, id, status as TenantStatus, note);
  if (!r.ok) return fail(r.code === "not_found" ? 404 : 409, r.error);
  clearTenantCache();
  return NextResponse.json({ status: r.status }, { headers: NO_STORE });
}
export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
