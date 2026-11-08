import { randomUUID } from "node:crypto";
import { chooseAgent, type Assignment, type LeadAgent, type RoutingRule, type RuleInput } from "../domain/ad-lead-routing";
import type { LeadInput } from "../domain/ad-leads";
import { appendAuditPg, type Queryable } from "./db";

/** Storage for lead routing rules and the agent choice made when a lead arrives. Parameterised SQL only. */

const atomic = <T>(db: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> => (db.transaction ? db.transaction(fn) : fn(db));
const audit = (db: Queryable, staffId: string, id: string, eventType: string, payload: Record<string, unknown>, now: string) =>
  appendAuditPg(db, { id: randomUUID(), occurredAt: now, actorType: "user", actorId: staffId, aggregateType: "ad_lead_rule", aggregateId: id, eventType, correlationId: randomUUID(), payload });

export interface StoredRule extends RoutingRule { position: number; enabled: boolean }
const RULE_COLS = "id, source_id, position, label, postcodes, suburbs, property_types, interests, agent_user_ids, enabled";
const toRule = (r: Record<string, unknown>): StoredRule => ({
  id: String(r["id"]), label: String(r["label"]), sourceId: r["source_id"] ? String(r["source_id"]) : null, position: Number(r["position"]), enabled: r["enabled"] === true,
  postcodes: (r["postcodes"] as string[]) ?? [], suburbs: (r["suburbs"] as string[]) ?? [], propertyTypes: (r["property_types"] as string[]) ?? [],
  interests: (r["interests"] as string[]) ?? [], agentUserIds: ((r["agent_user_ids"] as string[]) ?? []).map(String)
});

export async function listRules(db: Queryable): Promise<StoredRule[]> {
  return (await db.query(`SELECT ${RULE_COLS} FROM ad_lead_rule ORDER BY position, created_at LIMIT 500`)).rows.map(toRule);
}

export async function createRule(db: Queryable, staffId: string, i: RuleInput, now: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const id = randomUUID();
  try {
    await atomic(db, async tx => {
      // Every agent named must be a real, active agent account: a rule cannot route leads to a buyer or owner.
      const n = await tx.query("SELECT count(*) AS n FROM app_user WHERE id = ANY($1::uuid[]) AND user_type = 'agent' AND status = 'active' AND deleted_at IS NULL", [i.agentUserIds]);
      if (Number(n.rows[0]?.["n"]) !== i.agentUserIds.length) throw Object.assign(new Error("agents"), { code: "AGENTS" });
      await tx.query(
        `INSERT INTO ad_lead_rule (id, source_id, position, label, postcodes, suburbs, property_types, interests, agent_user_ids, created_by, created_at)
         VALUES ($1,$2::uuid,$3,$4,$5::text[],$6::text[],$7::text[],$8::text[],$9::uuid[],$10::uuid,$11::timestamptz)`,
        [id, i.sourceId, i.position, i.label, i.postcodes, i.suburbs, i.propertyTypes, i.interests, i.agentUserIds, staffId, now]);
      await audit(tx, staffId, id, "ad_lead.rule_created", { label: i.label, agents: i.agentUserIds.length }, now);
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "AGENTS") return { ok: false, error: "Every agent named must be an active agent account." };
    if (code === "23503") return { ok: false, error: "That ad source does not exist." };
    throw e;
  }
  return { ok: true, id };
}

export async function setRule(db: Queryable, staffId: string, id: string, action: "enable" | "disable" | "delete", now: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  return atomic(db, async tx => {
    const r = action === "delete"
      ? await tx.query("DELETE FROM ad_lead_rule WHERE id = $1::uuid RETURNING id", [id])
      : await tx.query("UPDATE ad_lead_rule SET enabled = $2 WHERE id = $1::uuid RETURNING id", [id, action === "enable"]);
    if (!r.rows[0]) return false;
    await audit(tx, staffId, id, action === "delete" ? "ad_lead.rule_deleted" : action === "enable" ? "ad_lead.rule_enabled" : "ad_lead.rule_disabled", {}, now);
    return true;
  });
}

// Active agents taking new work, with the leads they still have open and the area and property types from their profile.
const ELIGIBLE_SQL =
  "SELECT u.id, COALESCE(p.service_postcodes, '{}') AS service_postcodes, COALESCE(p.service_suburbs, '{}') AS service_suburbs, COALESCE(p.property_types, '{}') AS property_types, " +
  "(SELECT count(*) FROM ad_lead l WHERE l.assigned_agent_id = u.id AND l.status NOT IN ('qualified','lost') AND NOT l.is_test) AS open_leads " +
  "FROM app_user u LEFT JOIN agent_profile p ON p.user_id = u.id " +
  "WHERE u.user_type = 'agent' AND u.status = 'active' AND u.deleted_at IS NULL AND COALESCE(p.accepting_new, true) ORDER BY u.id LIMIT 2000";
export async function eligibleAgents(db: Queryable): Promise<LeadAgent[]> {
  return (await db.query(ELIGIBLE_SQL)).rows.map(r => ({
    userId: String(r["id"]), openLeads: Number(r["open_leads"]), servicePostcodes: (r["service_postcodes"] as string[]).map(String),
    serviceSuburbs: (r["service_suburbs"] as string[]).map(s => String(s).toLowerCase()), propertyTypes: (r["property_types"] as string[]).map(String)
  }));
}

/** The agent a new lead goes to, or null when nobody fits (staff then assign it). Rules for this source and rules for all sources apply, in order. */
export async function routeLead(db: Queryable, sourceId: string, defaultAgentId: string | null, lead: LeadInput): Promise<Assignment | null> {
  const rules = (await db.query(`SELECT ${RULE_COLS} FROM ad_lead_rule WHERE enabled AND (source_id IS NULL OR source_id = $1::uuid) ORDER BY position, created_at`, [sourceId])).rows.map(toRule);
  return chooseAgent(lead, rules, await eligibleAgents(db), { defaultAgentUserId: defaultAgentId });
}
