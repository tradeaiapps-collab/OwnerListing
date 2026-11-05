import { NextResponse } from "next/server";
import { CAMPAIGN_TEMPLATES, FIELDS, LIMITS, OPS, TRIGGERS } from "../../../../src/domain/automation";
import { createWorkflow, listWorkflows } from "../../../../src/server/automation-db";
import { getActor, getDb } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../src/server/http";
import { withApi } from "../../../../src/server/api/with-api";

/** Owners and agents only: automations message buyers on the sender's behalf. */
const allowed = (t: string) => t === "owner" || t === "agent";

/** The caller's workflows with run counts, plus the catalogue the builder offers (triggers, fields, operators, starter campaigns). */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (!allowed(actor.userType)) return failure({ ok: false, code: "forbidden", message: "Automations are for owners and agents." });
  const db = getDb();
  const [workflows, listings] = await Promise.all([
    listWorkflows(db, actor.userId),
    db.query(`SELECT l.id, l.title FROM property_listing l WHERE l.owner_user_id = $1::uuid OR EXISTS (SELECT 1 FROM listing_agent_appointment a WHERE a.listing_id = l.id AND a.agent_user_id = $1::uuid AND a.revoked_at IS NULL AND a.scope = 'full') ORDER BY l.created_at DESC LIMIT 100`, [actor.userId])
  ]);
  return NextResponse.json({
    workflows, listings: listings.rows.map(r => ({ id: String(r["id"]), title: String(r["title"]) })),
    triggers: Object.entries(TRIGGERS).map(([key, t]) => ({ key, ...t })), fields: Object.entries(FIELDS).map(([key, f]) => ({ key, ...f })), ops: OPS,
    templates: CAMPAIGN_TEMPLATES, limits: LIMITS
  }, { headers: { "cache-control": "no-store" } });
}

/** Create a workflow: { name, definition, listingId? }. It starts switched off; turn it on with PATCH { active: true }. */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (!allowed(actor.userType)) return failure({ ok: false, code: "forbidden", message: "Automations are for owners and agents." });
  const body = await req.json().catch(() => null);
  const r = await createWorkflow(getDb(), actor.userId, typeof body === "object" && body !== null ? body : {});
  return r.ok ? NextResponse.json(r.value, { status: 201 }) : failure({ ok: false, code: "invalid", message: r.message });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
