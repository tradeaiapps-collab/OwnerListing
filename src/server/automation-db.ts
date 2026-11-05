import { fillTemplate, type MessageKind, type Recipient, type RuleInput, type Trigger, type TriggerConfig } from "../domain/automation";
import type { Queryable } from "./db";
import { notifyUser } from "./notifier";

type Env = Readonly<Record<string, string | undefined>>;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : new Date(String(v)).toISOString());

export interface RuleRow extends RuleInput { id: string; createdAt: string; updatedAt: string; lastFiredAt: string | null; runs: number }
const toRule = (x: Record<string, unknown>): RuleRow => ({
  id: String(x["id"]), name: String(x["name"]), enabled: Boolean(x["enabled"]), trigger: String(x["trigger"]) as Trigger,
  triggerConfig: (x["trigger_config"] ?? {}) as TriggerConfig, recipient: String(x["recipient"]) as Recipient,
  messageKind: String(x["message_kind"]) as MessageKind, title: String(x["title"]), body: String(x["body"]), link: x["link"] === null ? null : String(x["link"]),
  createdAt: iso(x["created_at"])!, updatedAt: iso(x["updated_at"])!, lastFiredAt: iso(x["last_fired_at"]), runs: Number(x["runs"] ?? 0)
});
const SELECT = `SELECT r.*, (SELECT count(*)::int FROM automation_run a WHERE a.rule_id = r.id) AS runs FROM automation_rule r`;

export async function listRulesPg(db: Queryable): Promise<RuleRow[]> {
  return (await db.query(`${SELECT} ORDER BY r.created_at DESC LIMIT 200`)).rows.map(toRule);
}
export async function getRulePg(db: Queryable, id: string): Promise<RuleRow | null> {
  const r = (await db.query(`${SELECT} WHERE r.id = $1::uuid`, [id])).rows[0];
  return r ? toRule(r) : null;
}
export async function createRulePg(db: Queryable, r: RuleInput, by: string): Promise<string> {
  const x = await db.query(
    `INSERT INTO automation_rule (name, enabled, trigger, trigger_config, recipient, message_kind, title, body, link, created_by)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10::uuid) RETURNING id`,
    [r.name, r.enabled, r.trigger, JSON.stringify(r.triggerConfig), r.recipient, r.messageKind, r.title, r.body, r.link, by]);
  return String(x.rows[0]!["id"]);
}
export async function updateRulePg(db: Queryable, id: string, r: RuleInput): Promise<boolean> {
  const x = await db.query(
    `UPDATE automation_rule SET name=$2, enabled=$3, trigger=$4, trigger_config=$5::jsonb, recipient=$6, message_kind=$7, title=$8, body=$9, link=$10, updated_at=now()
      WHERE id = $1::uuid RETURNING id`,
    [id, r.name, r.enabled, r.trigger, JSON.stringify(r.triggerConfig), r.recipient, r.messageKind, r.title, r.body, r.link]);
  return x.rows.length > 0;
}
export async function setRuleEnabledPg(db: Queryable, id: string, enabled: boolean): Promise<boolean> {
  return (await db.query("UPDATE automation_rule SET enabled = $2, updated_at = now() WHERE id = $1::uuid RETURNING id", [id, enabled])).rows.length > 0;
}
/** A rule that has run is only switched off (its runs are history); one that never ran can be removed. */
export async function deleteRulePg(db: Queryable, id: string): Promise<"deleted" | "disabled" | "missing"> {
  const used = await db.query("SELECT 1 FROM automation_run WHERE rule_id = $1::uuid LIMIT 1", [id]);
  if (used.rows.length > 0) return (await setRuleEnabledPg(db, id, false)) ? "disabled" : "missing";
  return (await db.query("DELETE FROM automation_rule WHERE id = $1::uuid RETURNING id", [id])).rows.length > 0 ? "deleted" : "missing";
}

/** People a rule tells for one listing. Ids are looked up here, never taken from a request. */
async function recipientsFor(db: Queryable, recipient: Recipient, listingId: string, buyerId: string | null): Promise<{ ids: string[]; listing: string }> {
  const l = (await db.query("SELECT owner_user_id, address_text, title FROM property_listing WHERE id = $1::uuid AND deleted_at IS NULL", [listingId])).rows[0];
  if (!l) return { ids: [], listing: "" };
  const ids = new Set<string>();
  if (recipient === "owner" || recipient === "owner_and_agent") ids.add(String(l["owner_user_id"]));
  if (recipient === "agent" || recipient === "owner_and_agent") {
    const a = await db.query("SELECT agent_user_id FROM listing_agent_appointment WHERE listing_id = $1::uuid AND revoked_at IS NULL", [listingId]);
    for (const r of a.rows) ids.add(String(r["agent_user_id"]));
  }
  if (recipient === "buyer" && buyerId) ids.add(buyerId);
  return { ids: [...ids], listing: String(l["address_text"] ?? l["title"] ?? "") };
}

/** Fires one rule for one event once. The unique (rule, event) row is the lock: a repeat of the same event finds it and does nothing. */
async function fire(db: Queryable, rule: RuleRow, eventKey: string, listingId: string, buyerId: string | null, vars: { count?: number; days?: number }, env: Env): Promise<number> {
  const claim = await db.query(
    "INSERT INTO automation_run (rule_id, event_key, listing_id) VALUES ($1::uuid,$2,$3::uuid) ON CONFLICT (rule_id, event_key) DO NOTHING RETURNING id", [rule.id, eventKey, listingId]);
  const runId = claim.rows[0]?.["id"];
  if (!runId) return 0;
  const who = await recipientsFor(db, rule.recipient, listingId, buyerId);
  const v = { listing: who.listing, ...vars };
  for (const uid of who.ids) {
    await notifyUser(db, uid, rule.messageKind === "marketing_news" ? "marketing_news" : "system_notice",
      { title: fillTemplate(rule.title, v), text: fillTemplate(rule.body, v), listing: who.listing, ...(rule.link ? { link: rule.link } : {}) }, env);
  }
  await db.query("UPDATE automation_run SET recipients = $2 WHERE id = $1::uuid", [String(runId), who.ids.length]);
  await db.query("UPDATE automation_rule SET last_fired_at = now() WHERE id = $1::uuid", [rule.id]);
  return who.ids.length;
}

const enabledRules = async (db: Queryable, trigger: Trigger) =>
  (await db.query(`${SELECT} WHERE r.enabled AND r.trigger = $1`, [trigger])).rows.map(toRule);

/** An offer arrived. Never throws: automation must not block the offer. */
export async function emitOfferReceived(db: Queryable, p: { offerId: string; listingId: string; buyerUserId: string }, env: Env = process.env): Promise<void> {
  try {
    for (const r of await enabledRules(db, "offer_received")) await fire(db, r, `offer:${p.offerId}`, p.listingId, p.buyerUserId, {}, env);
  } catch {
    // Nothing identifying is logged; the caller carries on.
  }
}

/** A signed-in buyer opened a published listing. Records the view and fires any "viewed N times" rule the buyer has now reached. Never throws. */
export async function recordListingView(db: Queryable, p: { listingId: string; viewerUserId: string }, env: Env = process.env): Promise<void> {
  try {
    const own = await db.query("SELECT 1 FROM property_listing WHERE id = $1::uuid AND status = 'published' AND deleted_at IS NULL AND owner_user_id <> $2::uuid", [p.listingId, p.viewerUserId]);
    if (own.rows.length === 0) return;
    // At most one counted view per hour, so a page refresh is not a second visit.
    await db.query(
      `INSERT INTO listing_view (listing_id, viewer_user_id)
       SELECT $1::uuid, $2::uuid WHERE NOT EXISTS (SELECT 1 FROM listing_view WHERE listing_id = $1::uuid AND viewer_user_id = $2::uuid AND viewed_at > now() - interval '1 hour')`,
      [p.listingId, p.viewerUserId]);
    for (const r of await enabledRules(db, "listing_viewed_repeat")) {
      const views = r.triggerConfig.views ?? 3, days = r.triggerConfig.windowDays ?? 14;
      const n = Number((await db.query(
        "SELECT count(*)::int AS n FROM listing_view WHERE listing_id = $1::uuid AND viewer_user_id = $2::uuid AND viewed_at > now() - make_interval(days => $3::int)",
        [p.listingId, p.viewerUserId, days])).rows[0]?.["n"] ?? 0);
      if (n >= views) await fire(db, r, `view:${p.listingId}:${p.viewerUserId}`, p.listingId, p.viewerUserId, { count: n }, env);
    }
  } catch {
    // Nothing identifying is logged.
  }
}

/** Every enabled "listing live for N days" rule, applied to published listings old enough and not yet handled by that rule. */
export async function scanAgingListings(db: Queryable, env: Env = process.env, limit = 200): Promise<number> {
  let sent = 0;
  for (const r of await enabledRules(db, "listing_aging")) {
    const days = r.triggerConfig.days ?? 90;
    const due = await db.query(
      `SELECT l.id FROM property_listing l
        WHERE l.status = 'published' AND l.deleted_at IS NULL AND l.created_at <= now() - make_interval(days => $2::int)
          AND NOT EXISTS (SELECT 1 FROM automation_run a WHERE a.rule_id = $1::uuid AND a.event_key = 'aging:' || l.id::text)
        ORDER BY l.created_at LIMIT $3`, [r.id, days, limit]);
    for (const x of due.rows) {
      const id = String(x["id"]);
      sent += await fire(db, r, `aging:${id}`, id, null, { days }, env);
    }
  }
  return sent;
}

export interface RunRow { id: string; ruleId: string; ruleName: string; eventKey: string; recipients: number; createdAt: string }
export async function recentRunsPg(db: Queryable, limit = 30): Promise<RunRow[]> {
  const r = await db.query(
    `SELECT a.id, a.rule_id, r.name, a.event_key, a.recipients, a.created_at FROM automation_run a JOIN automation_rule r ON r.id = a.rule_id ORDER BY a.created_at DESC LIMIT $1`, [limit]);
  return r.rows.map(x => ({ id: String(x["id"]), ruleId: String(x["rule_id"]), ruleName: String(x["name"]), eventKey: String(x["event_key"]).split(":")[0]!, recipients: Number(x["recipients"]), createdAt: iso(x["created_at"])! }));
}
