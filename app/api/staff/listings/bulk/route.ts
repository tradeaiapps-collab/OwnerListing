import { after, NextResponse } from "next/server";
import { checkReason, parseBulkParams } from "../../../../../src/domain/listing-bulk";
import { getDb } from "../../../../../src/server/context";
import { previewBulk, resolveAgent, resolveSelection, startBulk } from "../../../../../src/server/listing-bulk-db";
import { readSelection } from "../../../../../src/server/listing-bulk-selection";
import { bulkIo } from "../../../../../src/server/listing-bulk-io";
import { fail, readJsonObject, staffGate } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";

/**
 * Body { action, params, ids | filter, dryRun?, reason, expectedCount }. With dryRun: what would happen, nothing changes. Otherwise runs the action
 * on up to 500 listings with the reason kept in the audit trail for each one; over 100 listings the run is queued (HTTP 202, poll
 * /api/staff/listings/bulk/{jobId}). expectedCount is the number the confirmation dialog showed; a different count is refused so a
 * changed filter cannot widen the run.
 */
async function handlePost(req: Request) {
  const staff = await staffGate(req, "listing.bulk");
  if (staff instanceof NextResponse) return staff;
  const body = await readJsonObject(req);
  if (!body) return fail(400, "Send a JSON object.");
  const sel = readSelection(body);
  if (!sel) return fail(400, "Select listings first.");
  const db = getDb();
  let raw = body["params"];
  if (body["action"] === "assign_agent") {
    const given = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>)["agent"] : undefined;
    const agentId = typeof given === "string" ? await resolveAgent(db, given) : null;
    if (!agentId) return fail(400, "No active agent found with that email or id.");
    raw = { agentId };
  }
  const parsed = parseBulkParams(body["action"], raw);
  if (!parsed.ok) return fail(400, parsed.error);
  const picked = await resolveSelection(db, sel);
  if ("error" in picked) return fail(400, picked.error);

  if (body["dryRun"] === true) {
    return NextResponse.json({ preview: await previewBulk(db, staff.id, picked.ids, parsed.params) }, { headers: { "cache-control": "no-store" } });
  }
  const reason = checkReason(body["reason"]);
  if (!reason.ok) return fail(400, reason.error);
  if (body["expectedCount"] !== picked.ids.length) return fail(409, `The selection changed: ${picked.ids.length} listings now match, not ${String(body["expectedCount"])}. Review and confirm again.`);

  const job = await startBulk(db, bulkIo(), { id: staff.id, role: staff.role }, parsed.params, reason.reason, picked.ids, work => after(work));
  return NextResponse.json({ job }, { status: job.status === "done" ? 200 : 202, headers: { "cache-control": "no-store" } });
}

export const POST = withApi(handlePost);
