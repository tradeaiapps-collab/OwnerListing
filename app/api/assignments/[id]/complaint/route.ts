import { parseComplaint } from "../../../../../src/domain/contractor-ops";
import { auditJob, insertComplaint } from "../../../../../src/server/contractor-ops-db";
import { error, json, withJob } from "../../../../../src/server/contractor-ops-route";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** The owner reports a problem with a job they accepted: { kind, details }. It appears in the staff contractor report. */
async function handlePost(req: Request, { params }: Ctx) {
  return withJob(req, params, true, async c => {
    if (c.job.role !== "owner") return error(403, "Only the owner can report a problem.");
    const parsed = parseComplaint(c.body);
    if (!parsed.ok) return error(400, parsed.message);
    if (!(await insertComplaint(c.db, c.job.id, c.userId, parsed.value.kind, parsed.value.details))) return error(409, "You can report a problem once the contractor has accepted the job.");
    await auditJob(c.db, c.userId, c.job.id, "complaint.filed", { kind: parsed.value.kind });
    return json({ ok: true }, 201);
  });
}

export const POST = withApi(handlePost);
