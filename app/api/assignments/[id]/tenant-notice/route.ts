import { parseTenantNotice } from "../../../../../src/domain/contractor-ops";
import { auditJob, listTenantNotices } from "../../../../../src/server/contractor-ops-db";
import { sendTenantNotice } from "../../../../../src/server/contractor-ops-notify";
import { error, json, withJob } from "../../../../../src/server/contractor-ops-route";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Notices already sent for this job. The tenant's email is never returned. Owner only. */
async function handleGet(req: Request, { params }: Ctx) {
  return withJob(req, params, false, async c => c.job.role !== "owner" ? error(403, "Only the owner can see tenant notices.") : json({ notices: await listTenantNotices(c.db, c.job.id) }));
}

/** The owner emails the tenant an entry window: { tenantName, tenantEmail, startsAt, endsAt }. At least 24 hours ahead. Accepted jobs only. */
async function handlePost(req: Request, { params }: Ctx) {
  return withJob(req, params, true, async c => {
    if (c.job.role !== "owner") return error(403, "Only the owner can send a tenant notice.");
    if (c.job.status !== "approved") return error(409, "Send the notice once the contractor has accepted the job.");
    const parsed = parseTenantNotice(c.body, new Date().toISOString());
    if (!parsed.ok) return error(400, parsed.message);
    const r = await sendTenantNotice(c.db, c.job, parsed.value);
    if (!r.ok) return error(r.code === "rate_limited" ? 429 : 503, r.message);
    await auditJob(c.db, c.userId, c.job.id, "tenant_notice.sent", { startsAt: parsed.value.startsAt, endsAt: parsed.value.endsAt });
    return json({ ok: true }, 201);
  });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
