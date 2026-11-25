import { NextResponse } from "next/server";
import { readHostedConfig } from "../adapters/hosted-engine";
import { readAiConfig } from "../adapters/ollama-engine";
import type { StaffActor } from "../domain/staff-access";
import { aiSwitchHistory, aiSwitchOn } from "./ai-switch-db";
import { getDb } from "./context";
import { fail, staffGate } from "./staff-route";

/**
 * /staff/ai is for super admins only: the sensitive permission ai.engine_set (held only by super_admin by default) and the
 * super_admin role itself, so a custom role given the permission still cannot switch the AI. CSRF is checked first (staffGate).
 */
export async function aiAdminGate(req: Request): Promise<StaffActor | NextResponse> {
  const staff = await staffGate(req, "ai.engine_set");
  if (staff instanceof NextResponse) return staff;
  return staff.role === "super_admin" ? staff : fail(403, "Not allowed.");
}

/** The switch, the server config (no secrets in it) and the history. */
export async function aiAdminView() {
  const hosted = readHostedConfig(process.env);
  const cfg = hosted.ok ? hosted : readAiConfig(process.env);
  const enabled = await aiSwitchOn(getDb());
  return {
    enabled,
    configured: cfg.ok,
    effective: enabled && cfg.ok,
    ...(cfg.ok ? { engine: hosted.ok ? "anthropic" : "ollama", model: cfg.config.model, endpoint: "endpoint" in cfg.config ? cfg.config.endpoint : "api.anthropic.com" } : { configState: cfg.state, problem: cfg.problem }),
    history: await aiSwitchHistory(getDb())
  };
}
