import { NextResponse } from "next/server";
import { readAiConfig } from "../../../../../src/adapters/ollama-engine";
import { AI_TEST_RATE, withinLimit, windowStart } from "../../../../../src/domain/rate-limit";
import { aiAdminGate } from "../../../../../src/server/ai-admin";
import { engineForConfig } from "../../../../../src/server/ai";
import { getDb } from "../../../../../src/server/context";
import { countHitPg } from "../../../../../src/server/offer-flow-db";
import { fail, staffAudit } from "../../../../../src/server/staff-route";

/**
 * "Test connection": asks the configured model server which models it has (GET /api/tags). Sends no listing or user data.
 * Works while the switch is off, so the admin can check before turning AI on. Rate limited per admin and overall (fail closed); audited.
 */
export async function POST(req: Request) {
  const staff = await aiAdminGate(req);
  if (staff instanceof NextResponse) return staff;
  const now = new Date().toISOString();
  const mine = await countHitPg(getDb(), `ai-test:${staff.id}`, windowStart(now, AI_TEST_RATE.windowMs));
  const all = await countHitPg(getDb(), "ai-test:all", windowStart(now, AI_TEST_RATE.windowMs));
  if (!withinLimit(mine, AI_TEST_RATE.perStaff) || !withinLimit(all, AI_TEST_RATE.allStaff)) return fail(429, "Too many tests. Try again later.");
  const cfg = readAiConfig(process.env);
  if (!cfg.ok) {
    await staffAudit(staff, "ai_switch", "site", "ai.connection_tested", { outcome: "not_configured" });
    return NextResponse.json({ outcome: "not_configured", error: cfg.problem }, { status: 409 });
  }
  const s = await engineForConfig(cfg.config).status();
  const outcome = !s.reachable ? "unreachable" : s.modelInstalled ? "ok" : "model_missing";
  await staffAudit(staff, "ai_switch", "site", "ai.connection_tested", { outcome, model: s.model, ...(s.error ? { errorCode: s.error } : {}) });
  return NextResponse.json({ outcome, reachable: s.reachable, model: s.model, modelInstalled: s.modelInstalled, ...(s.error ? { errorCode: s.error } : {}) });
}
