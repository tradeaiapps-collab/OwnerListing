import { findOverlaps, parseVisitInput } from "../../../../../src/domain/contractor-ops";
import { auditJob, committedSlots, confirmVisit, getVisit, proposeVisit } from "../../../../../src/server/contractor-ops-db";
import { notifyTimeProposed } from "../../../../../src/server/contractor-ops-notify";
import { error, json, withJob, type JobCall } from "../../../../../src/server/contractor-ops-route";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Warns a contractor before a time that clashes with another accepted job. They can go ahead by sending acknowledgeOverlap: true. */
async function overlapWarning(c: JobCall, startsAt: string, endsAt: string) {
  if (c.job.role !== "contractor" || c.body["acknowledgeOverlap"] === true) return null;
  const clash = findOverlaps({ assignmentId: c.job.id, startsAt, endsAt }, await committedSlots(c.db, c.userId));
  return clash.length === 0 ? null : error(409, "This time overlaps another job you have accepted.", { code: "overlap", overlaps: clash.map(s => ({ startsAt: s.startsAt, endsAt: s.endsAt })) });
}

const canConfirm = async (c: JobCall) => {
  const v = await getVisit(c.db, c.job.id);
  return !!v && v.state === "proposed" && v.proposedBy !== c.userId && (c.job.status === "proposed" || c.job.status === "approved");
};

/** The job's visit time, who attends, and the viewer's role and the job's status. */
async function handleGet(req: Request, { params }: Ctx) {
  return withJob(req, params, false, async c => json({ visit: (await getVisit(c.db, c.job.id)) ?? null, canConfirm: await canConfirm(c), role: c.job.role, status: c.job.status, kind: c.job.kind, address: c.job.role === "owner" || c.job.status === "approved" ? c.job.address : null, jurisdiction: c.job.jurisdiction }));
}

/** Either party proposes a time: { startsAt, endsAt, attendees? }. The other party then confirms it. */
async function handlePut(req: Request, { params }: Ctx) {
  return withJob(req, params, true, async c => {
    const parsed = parseVisitInput(c.body, new Date().toISOString());
    if (!parsed.ok) return error(400, parsed.message);
    const warn = await overlapWarning(c, parsed.value.startsAt, parsed.value.endsAt);
    if (warn) return warn;
    if (!(await proposeVisit(c.db, c.job.id, c.userId, parsed.value))) return error(409, "This job is finished, so its time cannot be changed.");
    await auditJob(c.db, c.userId, c.job.id, "visit.proposed", { startsAt: parsed.value.startsAt, endsAt: parsed.value.endsAt, attendees: parsed.value.attendees });
    await notifyTimeProposed(c.db, c.job, c.userId, parsed.value.startsAt, parsed.value.endsAt);
    return json({ visit: await getVisit(c.db, c.job.id) });
  });
}

/** Body: { action: "confirm", acknowledgeOverlap? }. Only the party that did not propose the time can confirm it. */
async function handlePost(req: Request, { params }: Ctx) {
  return withJob(req, params, true, async c => {
    if (c.body["action"] !== "confirm") return error(400, "Action must be confirm.");
    const visit = await getVisit(c.db, c.job.id);
    if (!visit) return error(404, "No time has been proposed yet.");
    const warn = await overlapWarning(c, visit.startsAt, visit.endsAt);
    if (warn) return warn;
    if (!(await confirmVisit(c.db, c.job.id, c.userId))) return error(409, "There is nothing for you to confirm.");
    await auditJob(c.db, c.userId, c.job.id, "visit.confirmed", { startsAt: visit.startsAt, endsAt: visit.endsAt });
    return json({ visit: await getVisit(c.db, c.job.id) });
  });
}

export const GET = withApi(handleGet);
export const PUT = withApi(handlePut);
export const POST = withApi(handlePost);
