import { NextResponse } from "next/server";
import type { InvestmentDeps } from "../domain/investment-service";
import type { Actor, Failure } from "../domain/listing-service";
import type { StaffActor, StaffPermission } from "../domain/staff-access";
import { getActor } from "./context";
import { csrfGuard } from "./csrf";
import { staffGate } from "./staff-route";

const STATUS: Record<Failure["code"], number> = { invalid: 400, not_found: 404, forbidden: 403, conflict: 409, rate_limited: 429, unavailable: 503 };
const NO_STORE = { "cache-control": "no-store" };
export const notFound = () => NextResponse.json({ error: "Not found." }, { status: 404 });
export const ok = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

export function invFailure(f: Failure & { fields?: Record<string, string>; step?: string }) {
  return NextResponse.json({ error: f.message, ...(f.fields ? { fields: f.fields } : {}), ...(f.step ? { step: f.step } : {}) }, { status: STATUS[f.code], headers: NO_STORE });
}

/**
 * Start of every investor route. Module off (either key) = 404 before anything else, so nothing reveals the module exists.
 * Then CSRF on state-changing methods, then the signed-in user confirmed against the database (401 if none).
 */
export async function investGate(req: Request, deps: InvestmentDeps, opts: { json?: boolean } = {}): Promise<Actor | NextResponse> {
  if (!(await deps.moduleState()).live) return notFound();
  const blocked = csrfGuard(req, opts);
  if (blocked) return blocked;
  const actor = await getActor(req);
  return actor ?? NextResponse.json({ error: "Sign in required." }, { status: 401 });
}

/** Staff review routes: module must be live (404 otherwise), then the usual staff gate. */
export async function investStaffGate(req: Request, deps: InvestmentDeps, p: StaffPermission): Promise<StaffActor | NextResponse> {
  if (!(await deps.moduleState()).live) return notFound();
  return staffGate(req, p);
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type Ctx = { params: Promise<{ id: string }> };
