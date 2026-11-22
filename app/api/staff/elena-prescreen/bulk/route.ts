import { NextResponse } from "next/server";
import { BULK_MAX_IDS, BULK_MAX_PER_HOUR, bulkEligible, evidenceNote, verifyEvidenceProblem } from "../../../../../src/domain/elena-prescreen";
import { planDecision } from "../../../../../src/domain/moderation-queue";
import { todayUtc } from "../../../../../src/domain/contractor-trust";
import { getDb } from "../../../../../src/server/context";
import { decideVerificationPg, listVerificationsPg } from "../../../../../src/server/contractor-trust-db";
import { bulkCountLastHourPg, bulkVerifyBlockersPg, logOutcomePg, withBulkLockPg, prescreenModerationPg, prescreenVerificationsPg } from "../../../../../src/server/elena-prescreen-db";
import { decideQueueItemPg, getQueueTargetPg, listQueuePg } from "../../../../../src/server/moderation-queue-db";
import { fail, readJsonObject, staffGate, UUID_RE } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";


/**
 * Staff confirm Elena's high-confidence approvals in one go.
 * Body: { "queue": "moderation" | "verification", "ids": [uuid, ...] (at most 25), "confirm": true, "evidence"?: { [userId]: { abnRegister: true, insuranceCertificate: true, licenceRegister?: true } } }.
 * Verification also needs the per-contractor "evidence" attestation (see verifyEvidenceProblem) and passes server-side standing checks (bulkVerifyBlockersPg).
 * Elena decides nothing: for each id the server recomputes her recommendation now, skips anything that is not "approve" at high confidence,
 * then applies the SAME decision a staff member would press on that screen (same permission, own-content block and guarded update).
 * Each applied decision is logged as a bulk outcome under this staff member. At most 100 bulk confirms per staff member per hour.
 */
async function handlePost(req: Request) {
  const body = await readJsonObject(req);
  const queue = body?.["queue"];
  if (queue !== "moderation" && queue !== "verification") return fail(400, 'Queue must be "moderation" or "verification".');
  const staff = await staffGate(req, queue === "moderation" ? "moderation.review" : "licence.verify");
  if (staff instanceof NextResponse) return staff;
  if (body?.["confirm"] !== true) return fail(400, "Confirm that you want to apply Elena's recommendations.");
  const ids = body?.["ids"];
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every(i => typeof i === "string" && UUID_RE.test(i))) return fail(400, "Send a list of item ids.");
  const unique = [...new Set(ids as string[])];
  if (unique.length > BULK_MAX_IDS) return fail(400, `At most ${BULK_MAX_IDS} items at a time.`);
  const db = getDb();
  // One bulk request per staff member at a time: the hourly count is read and the decisions applied under the same lock.
  const outcome = await withBulkLockPg(db, staff.id, async () => {
  const used = await bulkCountLastHourPg(db, staff.id);
  if (used + unique.length > BULK_MAX_PER_HOUR) return null;
  const results: { id: string; ok: boolean; message: string }[] = [];
  if (queue === "moderation") {
    const wanted = new Set(unique);
    const items = (await listQueuePg(db, { view: "open" }, 200)).filter(i => wanted.has(i.id));
    const screened = await prescreenModerationPg(db, items);
    for (const id of unique) {
      const item = items.find(i => i.id === id);
      const rec = screened.get(id);
      if (!item || !rec) { results.push({ id, ok: false, message: "Not an open item." }); continue; }
      if (!bulkEligible(rec)) { results.push({ id, ok: false, message: "Elena no longer recommends approving this with high confidence." }); continue; }
      const target = await getQueueTargetPg(db, id);
      const plan = target ? planDecision(staff, target, "approve", `Confirmed Elena's recommendation (${rec.rule}): ${rec.reason}`.slice(0, 480)) : null;
      if (!plan || plan.action === "deny") { results.push({ id, ok: false, message: plan?.action === "deny" ? plan.error : "Not found." }); continue; }
      // The outcome is logged inside the decision's transaction. If logging fails the decision rolls back and the run stops.
      try {
        if (!(await decideQueueItemPg(db, id, staff, plan.decision, plan.from, plan.note, {},
          tx => logOutcomePg(tx, { queue: "moderation", subjectId: id, staffId: staff.id, staffRole: staff.role, staffAction: "approve", viaBulk: true })))) { results.push({ id, ok: false, message: "Someone else already decided this item." }); continue; }
      } catch { results.push({ id, ok: false, message: "The outcome could not be logged, so this item was not approved and the rest were not applied." }); break; }
      results.push({ id, ok: true, message: "Approved." });
    }
  } else {
    const today = todayUtc();
    const rows = (await listVerificationsPg(db, "pending", today)).filter(v => unique.includes(v.userId));
    const screened = await prescreenVerificationsPg(db, rows, today);
    // Beyond Elena's text rules: the server checks standing and history, and each item needs the person's own evidence confirmation.
    const blockers = await bulkVerifyBlockersPg(db, rows.map(v => v.userId));
    const evidence = typeof body?.["evidence"] === "object" && body["evidence"] !== null && !Array.isArray(body["evidence"]) ? body["evidence"] as Record<string, unknown> : {};
    for (const id of unique) {
      const rec = screened.get(id);
      if (!rec) { results.push({ id, ok: false, message: "Not waiting for a check." }); continue; }
      if (!bulkEligible(rec)) { results.push({ id, ok: false, message: "Elena no longer recommends verifying this with high confidence." }); continue; }
      const row = rows.find(v => v.userId === id)!;
      const blocked = blockers.get(id);
      if (blocked) { results.push({ id, ok: false, message: blocked }); continue; }
      const hasLicence = !!row.licenceNumber;
      const missing = verifyEvidenceProblem(evidence[id], hasLicence);
      if (missing) { results.push({ id, ok: false, message: missing }); continue; }
      try {
        if (!(await decideVerificationPg(db, id, staff.id, "verify", `Confirmed Elena's recommendation (${rec.rule}). ${evidenceNote(hasLicence)}`, row.submittedAt,
          tx => logOutcomePg(tx, { queue: "verification", subjectId: id, staffId: staff.id, staffRole: staff.role, staffAction: "verify", viaBulk: true })))) { results.push({ id, ok: false, message: "Already decided, not found, or this is your own account." }); continue; }
      } catch { results.push({ id, ok: false, message: "The outcome could not be logged, so this contractor was not verified and the rest were not applied." }); break; }
      results.push({ id, ok: true, message: "Verified." });
    }
  }
  return results;
  });
  if (outcome === null) return fail(429, `Bulk confirm is limited to ${BULK_MAX_PER_HOUR} items an hour. Decide the rest one by one.`);
  const results = outcome;
  return NextResponse.json({ ok: true, applied: results.filter(r => r.ok).length, results });
}

export const POST = withApi(handlePost);
