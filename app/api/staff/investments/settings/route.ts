import { NextResponse } from "next/server";
import { INVESTMENT_DISCLOSURE } from "../../../../../src/config/investment-disclosure";
import { COUNSEL_CONFIRMATION, decideToggle, envMasterOn, moduleState } from "../../../../../src/domain/investor-projects";
import { INVESTMENT_RATE, windowStart, withinLimit } from "../../../../../src/domain/rate-limit";
import { getDb } from "../../../../../src/server/context";
import { loadSetting, saveToggle } from "../../../../../src/server/investments-db";
import { countHitPg } from "../../../../../src/server/offer-flow-db";
import { fail, readJsonObject, staffGate } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";

/** Super admin only (investment.manage). Reachable while the module is off, so it can be switched on and off. */
async function view() {
  const s = await loadSetting(getDb());
  return { ...moduleState(envMasterOn(process.env), s.dbOn), history: s.history, disclosure: INVESTMENT_DISCLOSURE, confirmation: COUNSEL_CONFIRMATION };
}

async function handleGet(req: Request) {
  const staff = await staffGate(req, "investment.manage");
  if (staff instanceof NextResponse) return staff;
  return NextResponse.json(await view(), { headers: { "cache-control": "no-store" } });
}

/** { enabled, counselConfirmed, disclosureVersion }. Turning on needs the counsel confirmation; turning off takes effect on the next request. */
async function handlePost(req: Request) {
  const staff = await staffGate(req, "investment.manage");
  if (staff instanceof NextResponse) return staff;
  const hits = await countHitPg(getDb(), `inv-toggle:${staff.id}`, windowStart(new Date().toISOString(), INVESTMENT_RATE.toggle.windowMs)).catch(() => undefined);
  if (!withinLimit(hits, INVESTMENT_RATE.toggle.perUser)) return fail(429, "Too many changes. Try again later.");
  const d = decideToggle(staff, await readJsonObject(req));
  if (!d.ok) return fail(d.status, d.error);
  await saveToggle(getDb(), staff, d.value);
  return NextResponse.json(await view(), { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
