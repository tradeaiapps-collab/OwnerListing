import { randomInt, randomUUID } from "node:crypto";
import {
  KIND_LABEL, LIMITS, checkOutbound, draftMessage, findRef, onAccepted, onAnswer, onDue, onProposal, onReply, rateLimited, readReply,
  type ElenaJob, type JobSettings, type JobState, type MessageKind, type Party, type Step
} from "../domain/elena-jobs";
import { formatAppointment } from "../domain/elena-scheduling";
import { isJurisdiction, type Jurisdiction } from "../domain/jurisdiction";
import type { LayoutEntry } from "../domain/listing-photos";
import { scanContent } from "../domain/content-filter";
import { autoDispatch } from "../domain/contractor-dispatch";
import { assignmentIds, createPgAssignmentRepository } from "./assignment-db";
import { createPgContractorProfileStore } from "./contractor-profile-db";
import type { Queryable } from "./db";
import { notifyUser } from "./notifier";

// Constant SQL text; user input only travels as bound parameters. Every owner-facing action checks owner_user_id in the statement itself.
// Messages are logged insert-only. Nothing here deletes anything.

const text = (v: unknown) => String(v);
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const optIso = (v: unknown) => (v === null || v === undefined ? undefined : iso(v));

export interface JobRow extends ElenaJob { ownerUserId: string; contractorUserId: string; jurisdiction: Jurisdiction; address: string; filesPulled: number; needsOwnerReason?: string }
export interface LogEntry { id: string; direction: "out" | "in"; party: Party; kind: string; body: string; status: string; reason?: string; at: string }
export interface Sender { send(userId: string, kind: MessageKind, title: string, body: string, link: string): Promise<boolean> }

/** Real delivery: in-app, email, text and push on the user's own notification settings (opt-outs are honoured at send time). */
export function createNotifySender(db: Queryable, env: Readonly<Record<string, string | undefined>> = process.env): Sender {
  return {
    async send(userId, _kind, title, body, link) {
      const r = await notifyUser(db, userId, "job_update", { title, text: body, link }, env);
      return r.inApp || r.email === "sent" || r.sms === "sent";
    }
  };
}

// ---- Settings -------------------------------------------------------------------------------------------------------------------

export const GET_SETTINGS_SQL = "SELECT handle_jobs, auto_reply, hide_new_files FROM elena_job_settings WHERE listing_id = $1::uuid";
/** Params: 1 listing, 2 owner (must own the listing), 3 handle, 4 auto-reply, 5 hide. Zero rows when the caller does not own it. */
export const SAVE_SETTINGS_SQL =
  "INSERT INTO elena_job_settings (listing_id, handle_jobs, auto_reply, hide_new_files, updated_by) " +
  "SELECT l.id, $3::boolean, $4::boolean AND $3::boolean, $5::boolean, $2::uuid FROM property_listing l WHERE l.id = $1::uuid AND l.owner_user_id = $2::uuid " +
  "ON CONFLICT (listing_id) DO UPDATE SET handle_jobs = EXCLUDED.handle_jobs, auto_reply = EXCLUDED.auto_reply, hide_new_files = EXCLUDED.hide_new_files, updated_by = EXCLUDED.updated_by, updated_at = now() RETURNING listing_id";

export async function getSettings(db: Queryable, listingId: string): Promise<JobSettings> {
  const r = (await db.query(GET_SETTINGS_SQL, [listingId])).rows[0];
  return { handleJobs: r?.["handle_jobs"] === true, autoReply: r?.["auto_reply"] === true, hideNewFiles: r?.["hide_new_files"] === true };
}
export async function saveSettings(db: Queryable, ownerId: string, listingId: string, s: JobSettings): Promise<boolean> {
  return (await db.query(SAVE_SETTINGS_SQL, [listingId, ownerId, s.handleJobs, s.autoReply, s.hideNewFiles])).rows.length === 1;
}
export function parseSettings(input: unknown): JobSettings | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const o = input as Record<string, unknown>;
  const b = (k: string) => (typeof o[k] === "boolean" ? (o[k] as boolean) : undefined);
  const h = b("handleJobs"), a = b("autoReply"), f = b("hideNewFiles");
  return h === undefined || a === undefined || f === undefined ? undefined : { handleJobs: h, autoReply: h && a, hideNewFiles: f };
}

// ---- Reading jobs ---------------------------------------------------------------------------------------------------------------

const JOB_COLS =
  "j.id, j.assignment_id, j.listing_id, j.kind, j.contact_ref, j.state, j.proposed_at, j.proposed_by, j.appointment_at, j.rounds, j.reminders, " +
  "j.next_action_at, j.created_at, j.owner_user_id, j.contractor_user_id, j.files_pulled, j.needs_owner_reason, l.jurisdiction, l.address_text";
export const JOB_BY_ID_SQL = `SELECT ${JOB_COLS} FROM elena_job j JOIN property_listing l ON l.id = j.listing_id WHERE j.id = $1::uuid`;
export const JOBS_FOR_LISTING_SQL = `SELECT ${JOB_COLS}, cu.display_name AS contractor_name FROM elena_job j JOIN property_listing l ON l.id = j.listing_id JOIN app_user cu ON cu.id = j.contractor_user_id WHERE j.listing_id = $1::uuid AND l.owner_user_id = $2::uuid ORDER BY j.created_at`;
export const JOB_BY_REF_SQL = `SELECT ${JOB_COLS} FROM elena_job j JOIN property_listing l ON l.id = j.listing_id WHERE j.contact_ref = $1::text`;
export const LAST_LOG_SQL = "SELECT id, direction, party, kind, body, status, reason, created_at FROM elena_job_message WHERE job_id = $1::uuid ORDER BY created_at DESC, id LIMIT 40";

function toJob(r: Record<string, unknown>): JobRow {
  const j = text(r["jurisdiction"]).trim();
  return {
    id: text(r["id"]), assignmentId: text(r["assignment_id"]), listingId: text(r["listing_id"]), kind: text(r["kind"]), contactRef: text(r["contact_ref"]),
    state: text(r["state"]) as JobState, rounds: Number(r["rounds"]), reminders: Number(r["reminders"]), createdAt: iso(r["created_at"]),
    ownerUserId: text(r["owner_user_id"]), contractorUserId: text(r["contractor_user_id"]), filesPulled: Number(r["files_pulled"]),
    jurisdiction: (isJurisdiction(j) ? j : "NSW") as Jurisdiction, address: text(r["address_text"]),
    ...(optIso(r["proposed_at"]) ? { proposedAt: optIso(r["proposed_at"])! } : {}),
    ...(r["proposed_by"] ? { proposedBy: text(r["proposed_by"]) as Party } : {}),
    ...(optIso(r["appointment_at"]) ? { appointmentAt: optIso(r["appointment_at"])! } : {}),
    ...(optIso(r["next_action_at"]) ? { nextActionAt: optIso(r["next_action_at"])! } : {}),
    ...(r["needs_owner_reason"] ? { needsOwnerReason: text(r["needs_owner_reason"]) } : {})
  };
}
const getJob = async (db: Queryable, id: string) => { const r = (await db.query(JOB_BY_ID_SQL, [id])).rows[0]; return r ? toJob(r) : undefined; };

export interface JobView { id: string; ref: string; kind: string; contractorName: string; state: JobState; proposedAt?: string; proposedBy?: Party; appointmentAt?: string; needsOwnerReason?: string; filesPulled: number; log: LogEntry[] }

/** The owner's view of every job on their listing, with Elena's log. */
export async function listJobsForOwner(db: Queryable, ownerId: string, listingId: string): Promise<JobView[]> {
  const rows = (await db.query(JOBS_FOR_LISTING_SQL, [listingId, ownerId])).rows;
  const out: JobView[] = [];
  for (const r of rows) {
    const j = toJob(r);
    const log = (await db.query(LAST_LOG_SQL, [j.id])).rows.map((m): LogEntry => ({
      id: text(m["id"]), direction: text(m["direction"]) as "out" | "in", party: text(m["party"]) as Party, kind: text(m["kind"]), body: text(m["body"]),
      status: text(m["status"]), ...(m["reason"] ? { reason: text(m["reason"]) } : {}), at: iso(m["created_at"])
    }));
    out.push({ id: j.id, ref: j.contactRef, kind: j.kind, contractorName: text(r["contractor_name"]), state: j.state, filesPulled: j.filesPulled, log,
      ...(j.proposedAt ? { proposedAt: j.proposedAt } : {}), ...(j.proposedBy ? { proposedBy: j.proposedBy } : {}),
      ...(j.appointmentAt ? { appointmentAt: j.appointmentAt } : {}), ...(j.needsOwnerReason ? { needsOwnerReason: j.needsOwnerReason } : {}) });
  }
  return out;
}

// ---- Sending --------------------------------------------------------------------------------------------------------------------

export const SENT_TIMES_SQL = "SELECT created_at FROM elena_job_message WHERE job_id = $1::uuid AND party = $2::text AND direction = 'out' AND status = 'sent' AND created_at > $3::timestamptz";
export const LOG_SQL = "INSERT INTO elena_job_message (id, job_id, direction, party, kind, body, status, reason) VALUES ($1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text, $7::text, $8)";
export const NAMES_SQL = "SELECT id, display_name FROM app_user WHERE id = ANY($1::uuid[])";

const log = (db: Queryable, jobId: string, direction: "in" | "out", party: Party, kind: string, body: string, status: string, reason?: string) =>
  db.query(LOG_SQL, [randomUUID(), jobId, direction, party, kind, body.slice(0, 2000) || "(empty)", status, reason ?? null]);

const MONEY_WORDS = /\b(?:price|quote|fee|cost|invoice|payment|deposit|discount|charge)\b/i;
const firstName = (n: string) => n.trim().split(/\s+/)[0] || "there";

/**
 * Sends one message for a job: fixed wording, content-checked, rate-limited, logged. Returns "sent", or why not.
 * A blocked message is never sent; the caller hands the job to the owner.
 */
export async function sendJobMessage(db: Queryable, sender: Sender, job: JobRow, to: Party, kind: MessageKind, now: string, extra: { count?: number; reason?: string; quote?: string } = {}): Promise<"sent" | "blocked" | "rate_limited" | "failed"> {
  const names = new Map((await db.query(NAMES_SQL, [[job.ownerUserId, job.contractorUserId]])).rows.map(r => [text(r["id"]), text(r["display_name"])]));
  let quote = extra.quote;
  if (kind === "contractor_reply" && quote !== undefined) {
    const q = `"${quote.replace(/\s+/g, " ").slice(0, 300)}"`;
    quote = scanContent(q).action === "block" || /\$\s?\d/.test(q) || MONEY_WORDS.test(q)
      ? "(it mentions contact details, money or blocked words, so it is only in the log below)" : q;
  }
  const draft = draftMessage(kind, {
    address: job.address, contractor: firstName(names.get(job.contractorUserId) ?? ""), owner: firstName(names.get(job.ownerUserId) ?? ""),
    kindLabel: KIND_LABEL[job.kind] ?? "contractor", ref: job.contactRef,
    ...(job.proposedAt ? { when: formatAppointment(job.proposedAt, job.jurisdiction) } : {}),
    ...(kind === "confirmed" || kind === "appointment_reminder" ? { when: formatAppointment(job.appointmentAt ?? job.proposedAt ?? now, job.jurisdiction) } : {}),
    count: job.filesPulled, ...(extra.reason ? { reason: extra.reason } : {}), ...(quote !== undefined ? { quote } : {})
  });
  const body = `${draft.body}\n\nJob ${job.contactRef}`;
  const check = checkOutbound({ title: draft.title, body });
  if (!check.ok) { await log(db, job.id, "out", to, kind, body, "blocked", check.reason); return "blocked"; }
  const since = new Date(new Date(now).getTime() - 24 * 3600_000).toISOString();
  const recent = (await db.query(SENT_TIMES_SQL, [job.id, to, since])).rows.map(r => iso(r["created_at"]));
  if (rateLimited(recent, now)) { await log(db, job.id, "out", to, kind, body, "rate_limited", "Daily message limit for this person on this job."); return "rate_limited"; }
  const userId = to === "owner" ? job.ownerUserId : job.contractorUserId;
  const link = to === "owner" ? `/listings/${job.listingId}` : "/jobs";
  const ok = await sender.send(userId, kind, draft.title, body, link).catch(() => false);
  await log(db, job.id, "out", to, kind, body, ok ? "sent" : "failed", ok ? undefined : "Delivery failed.");
  return ok ? "sent" : "failed";
}

// ---- Applying steps -------------------------------------------------------------------------------------------------------------

/** Params: 1 id, 2 expected state, 3 state, 4 proposed_at, 5 proposed_by, 6 appointment_at, 7 rounds, 8 reminders, 9 next_action_at, 10 reason. Guarded by the expected state and round count, so a replayed or concurrent proposal changes nothing. */
export const PATCH_SQL =
  "UPDATE elena_job SET state = $3::text, proposed_at = $4::timestamptz, proposed_by = $5::text, appointment_at = $6::timestamptz, rounds = $7::int, reminders = $8::int, " +
  "next_action_at = $9::timestamptz, needs_owner_reason = $10, updated_at = now() WHERE id = $1::uuid AND state = $2::text AND rounds = $11::int RETURNING id";

/**
 * Runs the steps from the domain: first the state change (so a crash cannot resend), then the messages. Returns false when the job moved
 * under us (someone else changed it), in which case nothing was sent.
 */
export async function applySteps(db: Queryable, sender: Sender, job: JobRow, steps: readonly Step[], now: string): Promise<boolean> {
  let next: JobRow = { ...job };
  let reason: string | undefined = job.needsOwnerReason;
  let nextAction: string | null | undefined = job.nextActionAt;
  for (const s of steps) {
    if (s.type !== "set") continue;
    const p = s.patch;
    if (p.state) next.state = p.state;
    if ("proposedAt" in p) { if (p.proposedAt) next.proposedAt = p.proposedAt; else delete next.proposedAt; }
    if ("proposedBy" in p) { if (p.proposedBy) next.proposedBy = p.proposedBy; else delete next.proposedBy; }
    if (p.appointmentAt) next.appointmentAt = p.appointmentAt;
    if (p.rounds !== undefined) next.rounds = p.rounds;
    if (p.reminders !== undefined) next.reminders = p.reminders;
    if ("nextActionAt" in p) nextAction = p.nextActionAt;
    if (p.reason) reason = p.reason;
  }
  const moved = await db.query(PATCH_SQL, [job.id, job.state, next.state, next.proposedAt ?? null, next.proposedBy ?? null, next.appointmentAt ?? null, next.rounds, next.reminders, nextAction ?? null, next.state === "needs_owner" ? reason ?? null : null, job.rounds]);
  if (moved.rows.length !== 1) return false;
  for (const s of steps) {
    if (s.type !== "send") continue;
    const r = await sendJobMessage(db, sender, next, s.to, s.kind, now);
    if (r === "blocked") {
      await db.query(PATCH_SQL, [job.id, next.state, "needs_owner", next.proposedAt ?? null, next.proposedBy ?? null, next.appointmentAt ?? null, next.rounds, next.reminders, null, "Elena's message was blocked by the safety filter. Please contact them directly.", next.rounds]);
      return true;
    }
  }
  if (next.state === "needs_owner" && job.state !== "needs_owner") {
    await sendJobMessage(db, sender, next, "owner", "needs_owner", now, { reason: reason ?? "Please take a look." });
  }
  return true;
}

// ---- Creating jobs --------------------------------------------------------------------------------------------------------------

/** Live assignments on listings where Elena handles jobs and has no job yet. */
export const NEW_JOBS_SQL =
  "SELECT a.id, a.listing_id, a.owner_user_id, a.contractor_user_id, a.kind, a.status FROM job_assignment a " +
  "JOIN elena_job_settings s ON s.listing_id = a.listing_id AND s.handle_jobs " +
  "WHERE a.status IN ('proposed','approved') AND NOT EXISTS (SELECT 1 FROM elena_job j WHERE j.assignment_id = a.id) ORDER BY a.id LIMIT 50";
export const INSERT_JOB_SQL =
  "INSERT INTO elena_job (id, assignment_id, listing_id, owner_user_id, contractor_user_id, kind, contact_ref, state, next_action_at) " +
  "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::text, $7::text, 'requested', $8::timestamptz) ON CONFLICT DO NOTHING RETURNING id";

async function createJob(db: Queryable, sender: Sender, a: Record<string, unknown>, now: string): Promise<boolean> {
  for (let i = 0; i < 5; i++) {
    const id = randomUUID();
    const ref = `EJ-${randomInt(100000, 1000000)}`;
    const ins = await db.query(INSERT_JOB_SQL, [id, text(a["id"]), text(a["listing_id"]), text(a["owner_user_id"]), text(a["contractor_user_id"]), text(a["kind"]), ref, now]);
    if (ins.rows.length !== 1) { if ((await db.query("SELECT 1 FROM elena_job WHERE assignment_id = $1::uuid", [text(a["id"])])).rows.length) return false; continue; }
    const job = (await getJob(db, id))!;
    // A new request is sent now; if the contractor already accepted, go straight to asking for a time.
    if (text(a["status"]) === "approved") await applySteps(db, sender, job, onAccepted(now), now);
    else await applySteps(db, sender, job, [{ type: "set", patch: { reminders: 0, nextActionAt: new Date(new Date(now).getTime() + LIMITS.reminderGapMs).toISOString() } }, { type: "send", to: "contractor", kind: "request" }], now);
    return true;
  }
  return false;
}

// ---- The scheduler tick ---------------------------------------------------------------------------------------------------------

/** Claims due jobs by pushing their next action 10 minutes out, so two ticks never act on the same job. */
export const CLAIM_DUE_SQL =
  "UPDATE elena_job SET next_action_at = $1::timestamptz + interval '10 minutes' WHERE id IN (" +
  "SELECT j.id FROM elena_job j JOIN elena_job_settings s ON s.listing_id = j.listing_id AND s.handle_jobs " +
  "WHERE j.next_action_at <= $1::timestamptz AND j.state NOT IN ('delivered','stopped','needs_owner') ORDER BY j.next_action_at LIMIT 50 FOR UPDATE OF j SKIP LOCKED) RETURNING id";
export const ASSIGNMENT_STATUS_SQL = "SELECT status FROM job_assignment WHERE id = $1::uuid";
/** Files the contractor added to the listing since the job began: gallery photos and documents. */
export const DELIVERED_SQL =
  "SELECT (SELECT count(*) FROM listing_photo WHERE listing_id = $1::uuid AND uploaded_by = $2::uuid AND uploaded_at >= $3::timestamptz) AS photos, " +
  "(SELECT count(*) FROM property_document WHERE listing_id = $1::uuid AND uploaded_by = $2::uuid AND uploaded_at >= $3::timestamptz) AS docs";

export async function deliveredCount(db: Queryable, job: JobRow): Promise<{ photos: number; docs: number }> {
  const r = (await db.query(DELIVERED_SQL, [job.listingId, job.contractorUserId, job.createdAt])).rows[0];
  return { photos: Number(r?.["photos"] ?? 0), docs: Number(r?.["docs"] ?? 0) };
}

export interface TickResult { created: number; acted: number; invited: number }

/** Listings where Elena handles jobs and a photographer or inspector slot is open (nobody live, or the last one declined). */
export const DISPATCH_LISTINGS_SQL =
  "SELECT l.id, l.owner_user_id, l.suburb, l.postcode FROM property_listing l JOIN elena_job_settings s ON s.listing_id = l.id AND s.handle_jobs " +
  "WHERE l.status IN ('draft','pending_review','published') AND (" +
  "SELECT count(*) FROM job_assignment a WHERE a.listing_id = l.id AND a.kind IN ('photographer','inspector') AND a.status <> 'cancelled') < 2 ORDER BY l.id LIMIT 25";

/** Picks and invites contractors for those open slots, through the normal invitation (the contractor must accept; the owner can cancel). */
export async function dispatchOpenSlots(db: Queryable, rows?: Record<string, unknown>[]): Promise<number> {
  const repo = createPgAssignmentRepository(db);
  const profiles = createPgContractorProfileStore(db);
  let invited = 0;
  for (const l of rows ?? (await db.query(DISPATCH_LISTINGS_SQL, [])).rows) {
    const r = await autoDispatch(repo, profiles, { userId: text(l["owner_user_id"]), userType: "owner" }, text(l["id"]),
      { ...(l["suburb"] ? { suburb: text(l["suburb"]) } : {}), ...(l["postcode"] ? { postcode: text(l["postcode"]).trim() } : {}) }, assignmentIds).catch(() => undefined);
    if (r?.ok) invited += r.value.filter(o => o.result === "invited").length;
  }
  return invited;
}

export async function runDueElenaJobs(db: Queryable, now: string, sender: Sender = createNotifySender(db)): Promise<TickResult> {
  let created = 0, acted = 0;
  const invited = await dispatchOpenSlots(db).catch(() => 0);
  for (const a of (await db.query(NEW_JOBS_SQL, [])).rows) if (await createJob(db, sender, a, now).catch(() => false)) created++;
  const claimed = (await db.query(CLAIM_DUE_SQL, [now])).rows.map(r => text(r["id"]));
  for (const id of claimed) {
    try {
      const job = await getJob(db, id);
      if (!job) continue;
      const status = text((await db.query(ASSIGNMENT_STATUS_SQL, [job.assignmentId])).rows[0]?.["status"]) as "proposed" | "approved" | "completed" | "cancelled";
      const d = await deliveredCount(db, job);
      // Put the claimed job back to its real time first; the steps set the next one.
      const steps = onDue(job, { assignmentStatus: status, deliveredFiles: d.photos + d.docs }, now);
      if (steps.length === 0) { await db.query("UPDATE elena_job SET next_action_at = NULL WHERE id = $1::uuid", [id]); continue; }
      const delivering = steps.some(s => s.type === "set" && s.patch.state === "delivered");
      if (delivering) await db.query("UPDATE elena_job SET files_pulled = $2::int WHERE id = $1::uuid", [id, d.photos + d.docs]);
      await applySteps(db, sender, delivering ? { ...job, filesPulled: d.photos + d.docs } : job, steps, now);
      if (delivering && d.photos > 0 && (await getSettings(db, job.listingId)).hideNewFiles) await setJobPhotosHidden(db, job, true);
      acted++;
    } catch { /* one bad job never stops the rest; it is retried after the claim expires */ }
  }
  return { created, acted, invited };
}

// ---- Gallery: the contractor's photos land in the gallery when uploaded; hide or show them ----------------------------------------

export const CONTRACTOR_PHOTOS_SQL = "SELECT id FROM listing_photo WHERE listing_id = $1::uuid AND uploaded_by = $2::uuid AND uploaded_at >= $3::timestamptz";
export const CURRENT_LAYOUT_SQL = "SELECT version, entries, tour_url FROM listing_photo_layout WHERE listing_id = $1::uuid ORDER BY version DESC LIMIT 1";

/** Appends a new gallery version with this job's photos hidden or shown. Earlier versions stay on record (no photo is ever deleted). */
export async function setJobPhotosHidden(db: Queryable, job: JobRow, hidden: boolean): Promise<boolean> {
  const ids = new Set((await db.query(CONTRACTOR_PHOTOS_SQL, [job.listingId, job.contractorUserId, job.createdAt])).rows.map(r => text(r["id"])));
  if (ids.size === 0) return false;
  const run = async (q: Queryable) => {
    await q.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`listing_photos:${job.listingId}`]);
    const cur = (await q.query(CURRENT_LAYOUT_SQL, [job.listingId])).rows[0];
    if (!cur) return false;
    const entries = (typeof cur["entries"] === "string" ? JSON.parse(cur["entries"]) : cur["entries"]) as LayoutEntry[];
    const next = entries.map(e => (ids.has(e.photoId) ? { ...e, hidden } : e));
    if (JSON.stringify(next) === JSON.stringify(entries)) return false;
    await q.query("INSERT INTO listing_photo_layout (listing_id, version, entries, tour_url, changed_by) VALUES ($1::uuid, $2::int, $3::jsonb, $4, $5::uuid)",
      [job.listingId, Number(cur["version"]) + 1, JSON.stringify(next), cur["tour_url"] ?? null, job.ownerUserId]);
    return true;
  };
  return db.transaction ? db.transaction(run) : run(db);
}

// ---- People acting on a job -----------------------------------------------------------------------------------------------------

export type ActResult = { ok: true } | { ok: false; code: "not_found" | "conflict" | "invalid" | "forbidden"; message: string };
const nf: ActResult = { ok: false, code: "not_found", message: "Not found." };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function partyOf(db: Queryable, jobId: string, userId: string): Promise<{ job: JobRow; party: Party } | undefined> {
  if (!UUID.test(jobId)) return undefined;
  const job = await getJob(db, jobId);
  if (!job) return undefined;
  return job.ownerUserId === userId ? { job, party: "owner" } : job.contractorUserId === userId ? { job, party: "contractor" } : undefined;
}

export const LIVE_ASSIGNMENT_SQL = "SELECT 1 FROM job_assignment WHERE id = $1::uuid AND status IN ('proposed','approved')";
const live = async (db: Queryable, job: JobRow) => (await db.query(LIVE_ASSIGNMENT_SQL, [job.assignmentId])).rows.length === 1;

/** In-app: the owner or the contractor suggests a time. */
export async function proposeTime(db: Queryable, sender: Sender, userId: string, jobId: string, at: string, now: string): Promise<ActResult> {
  const p = await partyOf(db, jobId, userId);
  if (!p) return nf;
  const t = new Date(at).getTime();
  if (!Number.isFinite(t) || t <= new Date(now).getTime() || t > new Date(now).getTime() + 180 * 86_400_000) return { ok: false, code: "invalid", message: "Choose a time in the next six months." };
  if (p.job.state !== "negotiating" || !(await live(db, p.job))) return { ok: false, code: "conflict", message: "This job is not waiting on a time." };
  return (await applySteps(db, sender, p.job, onProposal(p.job, p.party, new Date(t).toISOString(), now), now)) ? { ok: true } : { ok: false, code: "conflict", message: "This job changed. Refresh and try again." };
}
/** In-app: the other party says yes or no to the suggested time. */
export async function answerTime(db: Queryable, sender: Sender, userId: string, jobId: string, accept: boolean, now: string): Promise<ActResult> {
  const p = await partyOf(db, jobId, userId);
  if (!p) return nf;
  const steps = (await live(db, p.job)) ? onAnswer(p.job, p.party, accept, now) : [];
  if (steps.length === 0) return { ok: false, code: "conflict", message: "There is no time waiting for your answer." };
  return (await applySteps(db, sender, p.job, steps, now)) ? { ok: true } : { ok: false, code: "conflict", message: "This job changed. Refresh and try again." };
}

/** Owner controls: stop Elena on this job, hand it back to her, or hide or show the contractor's photos. */
export async function ownerAction(db: Queryable, userId: string, jobId: string, action: unknown, now: string): Promise<ActResult> {
  const p = await partyOf(db, jobId, userId);
  if (!p || p.party !== "owner") return nf;
  if (action === "stop") {
    if (p.job.state === "stopped" || p.job.state === "delivered") return { ok: false, code: "conflict", message: "Elena has already finished with this job." };
    const r = await db.query("UPDATE elena_job SET state = 'stopped', next_action_at = NULL, updated_at = now() WHERE id = $1::uuid AND state NOT IN ('stopped','delivered') RETURNING id", [jobId]);
    return r.rows.length ? { ok: true } : { ok: false, code: "conflict", message: "This job changed." };
  }
  if (action === "resume") {
    if (p.job.state !== "stopped" && p.job.state !== "needs_owner") return { ok: false, code: "conflict", message: "Elena is already handling this job." };
    const r = await db.query("UPDATE elena_job j SET state = CASE WHEN j.appointment_at IS NOT NULL THEN 'scheduled' WHEN a.status = 'approved' THEN 'negotiating' ELSE 'requested' END, reminders = 0, needs_owner_reason = NULL, next_action_at = $2::timestamptz, updated_at = now() FROM job_assignment a WHERE j.id = $1::uuid AND a.id = j.assignment_id AND a.status IN ('proposed','approved') AND j.state IN ('stopped','needs_owner') RETURNING j.id", [jobId, now]);
    return r.rows.length ? { ok: true } : { ok: false, code: "conflict", message: "This job changed." };
  }
  if (action === "hide_files" || action === "show_files") {
    await setJobPhotosHidden(db, p.job, action === "hide_files");
    return { ok: true };
  }
  return { ok: false, code: "invalid", message: "Action must be stop, resume, hide_files or show_files." };
}

// ---- Email replies --------------------------------------------------------------------------------------------------------------

export const NOTE_SENT_SQL = "SELECT 1 FROM elena_job_message WHERE job_id = $1::uuid AND party = $2::text AND kind = 'auto_reply_help' AND direction = 'out' AND created_at > $3::timestamptz LIMIT 1";
export const PARTY_EMAILS_SQL = "SELECT id, email FROM app_user WHERE id = ANY($1::uuid[])";

export type InboundResult = "ignored" | "handled" | "owner_only";

/**
 * One incoming email, already authenticated by the forwarder (`verified` = SPF/DKIM passed) and cleaned of quotes. The sender must be the
 * owner or the contractor of the job named by the reference in the subject or text. Free-form conversation is answered only where the owner
 * turned auto-reply on; money and questions always go to the owner.
 */
export async function handleInboundJobEmail(
  db: Queryable, sender: Sender, m: { from: string; subject: string; text: string; verified: boolean }, now: string
): Promise<InboundResult> {
  const ref = findRef(`${m.subject}\n${m.text}`);
  if (!ref) return "ignored";
  const jr = (await db.query(JOB_BY_REF_SQL, [ref])).rows[0];
  if (!jr) return "ignored";
  const job = toJob(jr);
  const emails = new Map((await db.query(PARTY_EMAILS_SQL, [[job.ownerUserId, job.contractorUserId]])).rows.map(r => [text(r["id"]), text(r["email"]).toLowerCase()]));
  const from: Party | undefined = emails.get(job.ownerUserId) === m.from ? "owner" : emails.get(job.contractorUserId) === m.from ? "contractor" : undefined;
  if (!from) return "ignored";
  if (!m.verified) { await log(db, job.id, "in", from, "email", m.text, "ignored", "Sender could not be verified."); return "ignored"; }
  const settings = await getSettings(db, job.listingId);
  if (!settings.handleJobs) { await log(db, job.id, "in", from, "email", m.text, "ignored", "Elena is switched off for this listing."); return "ignored"; }
  await log(db, job.id, "in", from, "email", m.text, "received");
  await db.query("UPDATE elena_job SET updated_at = now() WHERE id = $1::uuid", [job.id]);

  const decision = onReply(job, from, readReply(m.text, now, job.jurisdiction), settings, now);
  // One hand-over note per person per day, so two automatic senders can never keep each other talking.
  if (decision.steps.some(x => x.type === "send" && x.kind === "auto_reply_help")) {
    const since = new Date(new Date(now).getTime() - 24 * 3600_000).toISOString();
    if ((await db.query(NOTE_SENT_SQL, [job.id, from, since])).rows.length > 0) decision.steps = decision.steps.filter(x => !(x.type === "send" && x.kind === "auto_reply_help"));
  }
  if (decision.steps.length) await applySteps(db, sender, job, decision.steps, now);
  if (decision.toOwner && from === "contractor") await sendJobMessage(db, sender, job, "owner", "contractor_reply", now, { quote: m.text });
  return decision.toOwner ? "owner_only" : "handled";
}
