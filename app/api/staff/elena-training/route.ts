import { NextResponse } from "next/server";
import { acceptanceBy, differentiators, FEATURES } from "../../../../src/domain/elena-learning";
import { isUuid } from "../../../../src/domain/offer-decision";
import { getDb, getDeps } from "../../../../src/server/context";
import {
  activateConfigPg, activeConfigPg, createExperimentPg, experimentsPg, listConfigsPg, recordManualOutcomePg, stopExperimentPg, syncSettlementOutcomesPg, trainingDashboardPg
} from "../../../../src/server/elena-learning-db";
import { fail, readJsonObject, staffAudit, staffGate } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

/** Elena training dashboard data: capture and acceptance figures, outcomes, learned-settings versions and A/B results. Read only. */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "report.sales");
  if (staff instanceof NextResponse) return staff;
  const db = getDb();
  const now = getDeps().now();
  await syncSettlementOutcomesPg(db);
  const { facts, health } = await trainingDashboardPg(db, new Date(now));
  const active = await activeConfigPg(db);
  return NextResponse.json({
    health, active: active ?? null, differentiators: differentiators(health, active),
    byFeature: acceptanceBy(facts, "feature"), byType: acceptanceBy(facts, "featureType").slice(0, 30), byRegion: acceptanceBy(facts, "region"), byRole: acceptanceBy(facts, "role"),
    configs: await listConfigsPg(db), experiments: await experimentsPg(db, facts), features: FEATURES
  }, { headers: { "cache-control": "no-store" } });
}

const int = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : undefined);

/**
 * Staff actions, each with its own permission:
 *  { action: "outcome", settlementId, outcome, timeToSettlementDays?, finalPriceCents?, negotiationCount?, userSatisfaction? }  (case.manage)
 *  { action: "activate", version }  (ai.engine_set: a super admin turns a proposed learned version on)
 *  { action: "experiment", key, feature, arms: [a, b] } and { action: "stop_experiment", key }  (ai.engine_set)
 */
async function handlePost(req: Request) {
  const body = await readJsonObject(req);
  if (!body) return fail(400, "Send a JSON object.");
  const action = body["action"];
  const staff = await staffGate(req, action === "outcome" ? "case.manage" : "ai.engine_set");
  if (staff instanceof NextResponse) return staff;
  const db = getDb();
  if (action === "outcome") {
    const settlementId = body["settlementId"];
    if (!isUuid(settlementId)) return fail(400, "Choose a settlement.");
    if (body["outcome"] !== "settled" && body["outcome"] !== "fell_through") return fail(400, "Outcome must be settled or fell_through.");
    const sat = body["userSatisfaction"] === undefined ? undefined : int(body["userSatisfaction"], 1, 5);
    const days = body["timeToSettlementDays"] === undefined ? undefined : int(body["timeToSettlementDays"], 0, 1000);
    const price = body["finalPriceCents"] === undefined ? undefined : int(body["finalPriceCents"], 1, 100_000_000_000);
    const nego = body["negotiationCount"] === undefined ? undefined : int(body["negotiationCount"], 0, 200);
    if ((body["userSatisfaction"] !== undefined && sat === undefined) || (body["timeToSettlementDays"] !== undefined && days === undefined) || (body["finalPriceCents"] !== undefined && price === undefined) || (body["negotiationCount"] !== undefined && nego === undefined)) return fail(400, "Check the numbers.");
    const ok = await recordManualOutcomePg(db, {
      settlementId, outcome: body["outcome"], recordedBy: staff.id,
      ...(days !== undefined ? { timeToSettlementDays: days } : {}), ...(price !== undefined ? { finalPriceCents: price } : {}),
      ...(nego !== undefined ? { negotiationCount: nego } : {}), ...(sat !== undefined ? { userSatisfaction: sat } : {})
    });
    if (!ok) return fail(404, "Settlement not found.");
    await staffAudit(staff, "settlement_outcome", settlementId, "elena_outcome_recorded", { outcome: body["outcome"] });
    return NextResponse.json({ ok: true });
  }
  if (action === "activate") {
    const version = int(body["version"], 1, 100000);
    if (version === undefined) return fail(400, "Choose a version.");
    if (!(await activateConfigPg(db, version, staff.id, getDeps().now()))) return fail(409, "That version is not waiting for activation.");
    await staffAudit(staff, "elena_learned_config", String(version), "elena_config_activated", { version });
    return NextResponse.json({ ok: true });
  }
  if (action === "experiment") {
    const { key, feature, arms } = body;
    if (typeof key !== "string" || !/^[a-z0-9_]{3,40}$/.test(key)) return fail(400, "Key: 3 to 40 lowercase letters, digits or underscores.");
    if (typeof feature !== "string" || !(FEATURES as readonly string[]).includes(feature)) return fail(400, "Choose a feature.");
    if (!Array.isArray(arms) || arms.length < 2 || arms.length > 4 || !arms.every(a => typeof a === "string" && /^[a-z0-9_]{1,20}$/.test(a)) || new Set(arms).size !== arms.length) return fail(400, "Give 2 to 4 different arm names.");
    if (!(await createExperimentPg(db, key, feature, arms as string[], staff.id))) return fail(409, "An experiment with that key exists.");
    await staffAudit(staff, "elena_experiment", key, "elena_experiment_created", { feature, arms });
    return NextResponse.json({ ok: true });
  }
  if (action === "stop_experiment") {
    if (typeof body["key"] !== "string" || !(await stopExperimentPg(db, body["key"]))) return fail(404, "No running experiment with that key.");
    await staffAudit(staff, "elena_experiment", body["key"], "elena_experiment_stopped", {});
    return NextResponse.json({ ok: true });
  }
  return fail(400, "Unknown action.");
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
