import { accessView, parseAccessInput } from "../../../../../src/domain/contractor-ops";
import { auditJob, loadAccess, saveAccess } from "../../../../../src/server/contractor-ops-db";
import { error, json, withJob } from "../../../../../src/server/contractor-ops-route";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };
const KEY = () => process.env["MESSAGING_SETTINGS_KEY"];

/**
 * How to get in. The owner sees everything. The contractor sees the method always, but the key location or lockbox code only while the
 * job is accepted (never while it is only proposed, and not after it is completed or cancelled). Each time a contractor is shown details it is audited.
 */
async function handleGet(req: Request, { params }: Ctx) {
  return withJob(req, params, false, async c => {
    const a = await loadAccess(c.db, c.job.id, KEY());
    if (!a) return json({ access: null, role: c.job.role });
    const view = accessView(a.method, a.details, c.job.role, c.job.status);
    if (c.job.role === "contractor" && view.details !== null) await auditJob(c.db, c.userId, c.job.id, "access.viewed");
    return json({ access: view, role: c.job.role });
  });
}

/** The owner sets it: { method, details? }. Details are sealed before they are stored. */
async function handlePut(req: Request, { params }: Ctx) {
  return withJob(req, params, true, async c => {
    if (c.job.role !== "owner") return error(403, "Only the owner can set how the contractor gets in.");
    const parsed = parseAccessInput(c.body);
    if (!parsed.ok) return error(400, parsed.message);
    const r = await saveAccess(c.db, c.job.id, c.userId, parsed.value, KEY());
    if (!r.ok) return r.reason === "key_missing" ? error(503, "Access details cannot be stored safely until the site's encryption key is set.") : error(409, "This job is finished, so access cannot be changed.");
    await auditJob(c.db, c.userId, c.job.id, "access.set", { method: parsed.value.method });
    return json({ ok: true });
  });
}

export const GET = withApi(handleGet);
export const PUT = withApi(handlePut);
