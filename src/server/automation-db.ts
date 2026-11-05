import { randomUUID } from "node:crypto";
import {
  advance, LIMITS, parseDefinition, parseName, startRun, TRIGGERS,
  type Facts, type LogEntry, type RunState, type SendAction, type TriggerKey, type Valid, type WorkflowDefinition
} from "../domain/automation";
import { appendAuditPg, type Queryable } from "./db";
import { notifyUser } from "./notifier";

type Env = Readonly<Record<string, string | undefined>>;
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const bad = (message: string): { ok: false; message: string } => ({ ok: false, message });
/** The listing's owner, or an agent appointed with full scope, may manage automations for it. */
const MANAGES = "(l.owner_user_id = $1::uuid OR EXISTS (SELECT 1 FROM listing_agent_appointment a WHERE a.listing_id = l.id AND a.agent_user_id = $1::uuid AND a.revoked_at IS NULL AND a.scope = 'full'))";

export interface WorkflowRow { id: string; name: string; trigger: TriggerKey; definition: WorkflowDefinition; listingId: string | null; active: boolean; createdAt: string; updatedAt: string; runs?: Record<string, number> }

const toWorkflow = (r: Record<string, unknown>): WorkflowRow => ({
  id: String(r["id"]), name: String(r["name"]), trigger: r["trigger_key"] as TriggerKey, definition: r["definition"] as WorkflowDefinition,
  listingId: typeof r["listing_id"] === "string" ? r["listing_id"] : null, active: r["active"] === true, createdAt: iso(r["created_at"]), updatedAt: iso(r["updated_at"])
});

export async function listWorkflows(db: Queryable, userId: string): Promise<WorkflowRow[]> {
  const r = await db.query(
    `SELECT w.*, COALESCE((SELECT jsonb_object_agg(status, n) FROM (SELECT status, count(*)::int AS n FROM automation_run WHERE workflow_id = w.id GROUP BY status) s), '{}'::jsonb) AS run_counts
       FROM automation_workflow w WHERE w.owner_user_id = $1::uuid AND w.archived_at IS NULL ORDER BY w.created_at DESC`, [userId]);
  return r.rows.map(x => ({ ...toWorkflow(x), runs: (x["run_counts"] ?? {}) as Record<string, number> }));
}

async function canUseListing(db: Queryable, userId: string, listingId: string): Promise<boolean> {
  const r = await db.query(`SELECT 1 FROM property_listing l WHERE l.id = $2::uuid AND ${MANAGES}`, [userId, listingId]);
  return r.rows.length > 0;
}

interface WorkflowInput { name?: unknown; definition?: unknown; listingId?: unknown; active?: unknown }

export async function createWorkflow(db: Queryable, userId: string, input: WorkflowInput): Promise<Valid<WorkflowRow>> {
  const name = parseName(input.name); if (!name.ok) return name;
  const def = parseDefinition(input.definition); if (!def.ok) return def;
  const listingId = typeof input.listingId === "string" && input.listingId !== "" ? input.listingId : null;
  if (listingId !== null && !(await canUseListing(db, userId, listingId).catch(() => false))) return bad("That listing is not one you manage.");
  const count = (await db.query("SELECT count(*)::int AS n FROM automation_workflow WHERE owner_user_id = $1::uuid AND archived_at IS NULL", [userId])).rows[0]?.["n"];
  if (typeof count === "number" && count >= LIMITS.perOwner) return bad(`You can have up to ${LIMITS.perOwner} workflows. Archive one first.`);
  const id = randomUUID();
  const r = await db.query(
    "INSERT INTO automation_workflow (id, owner_user_id, name, trigger_key, definition, listing_id, active) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING *",
    [id, userId, name.value, def.value.trigger, JSON.stringify(def.value), listingId, false]); // always starts switched off: the owner reviews, tests, then turns it on
  await audit(db, userId, id, "automation.created", { trigger: def.value.trigger });
  return { ok: true, value: toWorkflow(r.rows[0]!) };
}

export async function updateWorkflow(db: Queryable, userId: string, id: string, input: WorkflowInput): Promise<Valid<WorkflowRow>> {
  const cur = await db.query("SELECT * FROM automation_workflow WHERE id = $1::uuid AND owner_user_id = $2::uuid AND archived_at IS NULL", [id, userId]);
  if (!cur.rows[0]) return bad("Workflow not found.");
  const row = toWorkflow(cur.rows[0]);
  let name = row.name, def = row.definition, listingId = row.listingId, active = row.active;
  if (input.name !== undefined) { const n = parseName(input.name); if (!n.ok) return n; name = n.value; }
  if (input.definition !== undefined) { const d = parseDefinition(input.definition); if (!d.ok) return d; def = d.value; }
  if (input.listingId !== undefined) {
    listingId = typeof input.listingId === "string" && input.listingId !== "" ? input.listingId : null;
    if (listingId !== null && !(await canUseListing(db, userId, listingId).catch(() => false))) return bad("That listing is not one you manage.");
  }
  if (input.active !== undefined) { if (typeof input.active !== "boolean") return bad("active must be true or false."); active = input.active; }
  const r = await db.query(
    "UPDATE automation_workflow SET name=$3, trigger_key=$4, definition=$5::jsonb, listing_id=$6, active=$7, updated_at=now() WHERE id=$1::uuid AND owner_user_id=$2::uuid RETURNING *",
    [id, userId, name, def.trigger, JSON.stringify(def), listingId, active]);
  await audit(db, userId, id, active !== row.active ? (active ? "automation.activated" : "automation.paused") : "automation.updated", {});
  return { ok: true, value: toWorkflow(r.rows[0]!) };
}

/** Archives a workflow and ends its unfinished runs. Nothing is deleted. */
export async function archiveWorkflow(db: Queryable, userId: string, id: string): Promise<boolean> {
  const r = await db.query("UPDATE automation_workflow SET active = false, archived_at = now() WHERE id=$1::uuid AND owner_user_id=$2::uuid AND archived_at IS NULL RETURNING id", [id, userId]);
  if (!r.rows[0]) return false;
  const runs = await db.query("UPDATE automation_run SET status='stopped', wake_at=NULL, finished_at=now() WHERE workflow_id=$1::uuid AND status IN ('running','waiting') RETURNING id", [id]);
  for (const x of runs.rows) await db.query("INSERT INTO automation_log (run_id, workflow_id, kind, detail) VALUES ($1,$2,'stopped','Workflow archived.')", [x["id"], id]);
  await audit(db, userId, id, "automation.archived", {});
  return true;
}

export async function activityFor(db: Queryable, userId: string, id: string, limit = 60) {
  const own = await db.query("SELECT 1 FROM automation_workflow WHERE id=$1::uuid AND owner_user_id=$2::uuid", [id, userId]);
  if (!own.rows[0]) return undefined;
  const logs = await db.query(
    "SELECT id, run_id, at, kind, step_id, detail, outcome FROM automation_log WHERE workflow_id=$1::uuid ORDER BY id DESC LIMIT $2", [id, limit]);
  const runs = await db.query("SELECT status, count(*)::int AS n FROM automation_run WHERE workflow_id=$1::uuid GROUP BY status", [id]);
  return {
    counts: Object.fromEntries(runs.rows.map(r => [String(r["status"]), Number(r["n"])])),
    log: logs.rows.map(r => ({ id: String(r["id"]), runId: String(r["run_id"]), at: iso(r["at"]), kind: String(r["kind"]), stepId: typeof r["step_id"] === "string" ? r["step_id"] : null, detail: String(r["detail"]), outcome: typeof r["outcome"] === "string" ? r["outcome"] : null }))
  };
}

const audit = (db: Queryable, userId: string, id: string, eventType: string, payload: Record<string, unknown>) =>
  appendAuditPg(db, { id: randomUUID(), occurredAt: new Date().toISOString(), actorType: "user", actorId: userId, aggregateType: "automation_workflow", aggregateId: id, eventType, correlationId: randomUUID(), payload }).catch(() => undefined);

// ---- Events ----------------------------------------------------------------------------------------------------------------------

export type AutomationEvent =
  | { trigger: "new_lead"; enquiryId: string }
  | { trigger: "property_listed"; listingId: string }
  | { trigger: "offer_received"; offerId: string }
  | { trigger: "inspection_complete"; inspectionId: string };

interface Loaded { subjectKey: string; listingId: string; contactUserId: string | null; facts: Facts }
const firstName = (n: unknown) => String(n ?? "").trim().split(/\s+/)[0]?.slice(0, 40) ?? "";

/** Reads the facts for an event from the database. Nothing comes from the request. Listing facts and a first name only. */
async function load(db: Queryable, e: AutomationEvent): Promise<Loaded | undefined> {
  const L = "l.title AS listing_title, l.address_text, l.transaction_type, l.property_type";
  if (e.trigger === "new_lead") {
    const r = await db.query(`SELECT q.listing_id, q.buyer_user_id, u.display_name, ${L}, (SELECT count(*)::int FROM enquiry x WHERE x.listing_id = q.listing_id) AS n
      FROM enquiry q JOIN property_listing l ON l.id = q.listing_id JOIN app_user u ON u.id = q.buyer_user_id WHERE q.id = $1::uuid`, [e.enquiryId]);
    const x = r.rows[0]; if (!x) return undefined;
    return { subjectKey: e.enquiryId, listingId: String(x["listing_id"]), contactUserId: String(x["buyer_user_id"]),
      facts: { listing_title: String(x["listing_title"]), listing_suburb_text: String(x["address_text"]), contact_first_name: firstName(x["display_name"]), enquiries_on_listing: Number(x["n"]) } };
  }
  if (e.trigger === "property_listed") {
    const r = await db.query(`SELECT l.id AS listing_id, ${L} FROM property_listing l WHERE l.id = $1::uuid AND l.status = 'published'`, [e.listingId]);
    const x = r.rows[0]; if (!x) return undefined;
    return { subjectKey: e.listingId, listingId: e.listingId, contactUserId: null,
      facts: { listing_title: String(x["listing_title"]), listing_suburb_text: String(x["address_text"]), transaction_type: String(x["transaction_type"]), property_type: String(x["property_type"]) } };
  }
  if (e.trigger === "offer_received") {
    const r = await db.query(`SELECT o.listing_id, o.buyer_user_id, o.price_cents, o.settlement_days, u.display_name, ${L}, (SELECT count(*)::int FROM formal_offer x WHERE x.listing_id = o.listing_id) AS n
      FROM formal_offer o JOIN property_listing l ON l.id = o.listing_id JOIN app_user u ON u.id = o.buyer_user_id WHERE o.id = $1::uuid`, [e.offerId]);
    const x = r.rows[0]; if (!x) return undefined;
    return { subjectKey: e.offerId, listingId: String(x["listing_id"]), contactUserId: String(x["buyer_user_id"]),
      facts: { listing_title: String(x["listing_title"]), contact_first_name: firstName(x["display_name"]), offer_price: Math.round(Number(x["price_cents"]) / 100), offers_on_listing: Number(x["n"]), settlement_days: Number(x["settlement_days"]) } };
  }
  const r = await db.query(`SELECT i.listing_id, i.inspection_type, ${L}, (SELECT count(*)::int FROM inspection_finding f WHERE f.inspection_id = i.id) AS n
    FROM inspection i JOIN property_listing l ON l.id = i.listing_id WHERE i.id = $1::uuid AND i.status = 'completed'`, [e.inspectionId]);
  const x = r.rows[0]; if (!x) return undefined;
  return { subjectKey: e.inspectionId, listingId: String(x["listing_id"]), contactUserId: null,
    facts: { listing_title: String(x["listing_title"]), inspection_type: String(x["inspection_type"]), findings_count: Number(x["n"]) } };
}

/**
 * Called after an event happened (an enquiry saved, a listing published, ...). Starts one run for every active workflow that matches
 * and whose owner manages the listing, then lets each run take its first steps. Re-firing the same event is a no-op.
 * NEVER throws: automations must not block the action that caused them.
 */
export async function fireAutomation(db: Queryable, e: AutomationEvent, nowIso = new Date().toISOString(), env: Env = process.env): Promise<{ started: number }> {
  try {
    const ev = await load(db, e);
    if (!ev) return { started: 0 };
    const ws = await db.query(
      `SELECT w.* FROM automation_workflow w JOIN property_listing l ON l.id = $2::uuid
        WHERE w.trigger_key = $1 AND w.active AND w.archived_at IS NULL AND (w.listing_id IS NULL OR w.listing_id = l.id)
          AND (l.owner_user_id = w.owner_user_id OR EXISTS (SELECT 1 FROM listing_agent_appointment a WHERE a.listing_id = l.id AND a.agent_user_id = w.owner_user_id AND a.revoked_at IS NULL AND a.scope = 'full'))`,
      [e.trigger, ev.listingId]);
    let started = 0;
    for (const w of ws.rows) {
      const def = parseDefinition(w["definition"]);
      if (!def.ok) continue;
      const s = startRun(def.value, ev.facts, nowIso);
      if ("skipped" in s) continue;
      const runId = randomUUID();
      const ins = await db.query(
        `INSERT INTO automation_run (id, workflow_id, subject_key, contact_user_id, listing_id, facts, definition, status, step_index, wake_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,'running',0,$8) ON CONFLICT (workflow_id, subject_key) DO NOTHING RETURNING id`,
        [runId, w["id"], ev.subjectKey, ev.contactUserId, ev.listingId, JSON.stringify(ev.facts), JSON.stringify(def.value), nowIso]);
      if (!ins.rows[0]) continue;
      await writeLogs(db, runId, String(w["id"]), s.logs);
      started += 1;
      await processRun(db, runId, nowIso, env);
    }
    return { started };
  } catch {
    return { started: 0 };
  }
}

async function writeLogs(db: Queryable, runId: string, workflowId: string, logs: readonly LogEntry[]): Promise<void> {
  for (const l of logs) await db.query("INSERT INTO automation_log (run_id, workflow_id, kind, step_id, detail) VALUES ($1,$2,$3,$4,$5)", [runId, workflowId, l.kind, l.stepId, l.detail.slice(0, 300)]);
}

// ---- Running ---------------------------------------------------------------------------------------------------------------------

const LEASE_MS = 10 * 60 * 1000;
const BATCH = 50;

/** Takes due runs for this pass. SKIP LOCKED plus a lease keep two passes from working the same run; a dead pass's runs come back. */
async function claim(db: Queryable, nowIso: string, runId?: string): Promise<Record<string, unknown>[]> {
  const lease = new Date(Date.parse(nowIso) + LEASE_MS).toISOString();
  const r = await db.query(
    `UPDATE automation_run SET wake_at = $2 WHERE id IN (
       SELECT r.id FROM automation_run r JOIN automation_workflow w ON w.id = r.workflow_id
        WHERE r.status IN ('running','waiting') AND r.wake_at <= $1 AND ($3::uuid IS NULL OR r.id = $3::uuid)
        ORDER BY r.wake_at LIMIT ${BATCH} FOR UPDATE OF r SKIP LOCKED)
     RETURNING id, workflow_id, contact_user_id, listing_id, facts, definition, status, step_index`,
    [nowIso, lease, runId ?? null]);
  return r.rows;
}

export async function processRun(db: Queryable, runId: string, nowIso: string, env: Env = process.env): Promise<void> {
  for (const row of await claim(db, nowIso, runId)) await work(db, row, nowIso, env);
}

/** One scheduler tick: advances every run whose wait is over. Call it every few minutes. */
export async function runDueAutomations(db: Queryable, nowIso: string, env: Env = process.env): Promise<{ processed: number }> {
  const rows = await claim(db, nowIso);
  for (const row of rows) await work(db, row, nowIso, env);
  return { processed: rows.length };
}

async function work(db: Queryable, row: Record<string, unknown>, nowIso: string, env: Env): Promise<void> {
  const runId = String(row["id"]), workflowId = String(row["workflow_id"]);
  try {
    const def = parseDefinition(row["definition"]);
    if (!def.ok) throw new Error("bad definition");
    const w = await db.query("SELECT owner_user_id, active, archived_at FROM automation_workflow WHERE id = $1::uuid", [workflowId]);
    const owner = w.rows[0];
    // Paused or archived workflows hold their runs where they are: a paused one resumes when switched on again.
    if (!owner || owner["archived_at"] !== null) { await finish(db, runId, workflowId, "stopped", "Workflow archived."); return; }
    if (owner["active"] !== true) { await db.query("UPDATE automation_run SET wake_at = $2 WHERE id = $1::uuid", [runId, new Date(Date.parse(nowIso) + 15 * 60_000).toISOString()]); return; }
    const state: RunState = { status: row["status"] as RunState["status"], stepIndex: Number(row["step_index"]), wakeAt: null };
    const res = advance(def.value, state, (row["facts"] ?? {}) as Facts, nowIso);
    // Save the new position and the log first, then send: a crash can lose a message, never double it.
    const pending: { logId: string; action: SendAction }[] = [];
    await db.query(
      "UPDATE automation_run SET status=$2, step_index=$3, wake_at=$4, finished_at = CASE WHEN $2 IN ('completed','stopped','failed') THEN now() ELSE NULL END WHERE id=$1::uuid",
      [runId, res.state.status, res.state.stepIndex, res.state.wakeAt]);
    await writeLogs(db, runId, workflowId, res.logs);
    for (const a of res.actions) {
      const r = await db.query("INSERT INTO automation_log (run_id, workflow_id, kind, step_id, detail, outcome) VALUES ($1,$2,'sent',$3,$4,'pending') RETURNING id",
        [runId, workflowId, a.stepId, `${a.channel} to ${a.to}: ${a.subject || a.body}`.slice(0, 300)]);
      pending.push({ logId: String(r.rows[0]?.["id"]), action: a });
    }
    for (const p of pending) {
      const outcome = await deliver(db, p.action, String(owner["owner_user_id"]), typeof row["contact_user_id"] === "string" ? row["contact_user_id"] : null, env).catch(() => "failed" as const);
      await db.query("UPDATE automation_log SET outcome = $2 WHERE id = $1::bigint", [p.logId, outcome]);
    }
  } catch {
    await finish(db, runId, workflowId, "failed", "The run could not continue.").catch(() => undefined);
  }
}

async function finish(db: Queryable, runId: string, workflowId: string, status: "stopped" | "failed", detail: string) {
  await db.query("UPDATE automation_run SET status=$2, wake_at=NULL, finished_at=now() WHERE id=$1::uuid", [runId, status]);
  await writeLogs(db, runId, workflowId, [{ kind: status, stepId: null, detail }]);
}

/** Sends one step through the notification rules: the person's own preferences, quiet hours, unsubscribe links and rate limits all apply. */
export async function deliver(db: Queryable, a: SendAction, ownerId: string, contactId: string | null, env: Env = process.env): Promise<"sent" | "skipped" | "failed"> {
  const target = a.to === "owner" ? ownerId : contactId;
  if (!target) return "skipped";
  const kind = a.to === "owner" ? "automation_alert" : "automation_message";
  const r = await notifyUser(db, target, kind, { title: a.subject || (a.to === "owner" ? "Automation update" : "A message about a property"), text: a.body, link: a.to === "owner" ? "/agent/automations" : "/notifications" }, env,
    a.channel);
  const v = a.channel === "in_app" ? (r.inApp ? "sent" : "skipped") : r[a.channel === "email" ? "email" : "sms"];
  return v;
}

export { TRIGGERS };
