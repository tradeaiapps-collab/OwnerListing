import { NextResponse } from "next/server";
import { MODEL_EXPLAINERS, posterText, validatePostingSettings } from "../../../../../src/domain/investment-terms";
import { INVESTMENT_RATE, windowStart, withinLimit } from "../../../../../src/domain/rate-limit";
import { getDb } from "../../../../../src/server/context";
import { loadPosting, loadPostingHistory, savePosting } from "../../../../../src/server/investments-db";
import { countHitPg } from "../../../../../src/server/offer-flow-db";
import { fail, readJsonObject, staffGate } from "../../../../../src/server/staff-route";

/** Posting model settings (investment.manage). Reachable while the module is off. Changes apply to projects posted afterwards only. */
async function view() {
  const settings = await loadPosting(getDb());
  return { settings, posterText: posterText(settings), explainers: MODEL_EXPLAINERS, history: await loadPostingHistory(getDb()) };
}

export async function GET(req: Request) {
  const staff = await staffGate(req, "investment.manage");
  if (staff instanceof NextResponse) return staff;
  return NextResponse.json(await view(), { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const staff = await staffGate(req, "investment.manage");
  if (staff instanceof NextResponse) return staff;
  const hits = await countHitPg(getDb(), `inv-posting:${staff.id}`, windowStart(new Date().toISOString(), INVESTMENT_RATE.toggle.windowMs)).catch(() => undefined);
  if (!withinLimit(hits, INVESTMENT_RATE.toggle.perUser)) return fail(429, "Too many changes. Try again later.");
  const v = validatePostingSettings(await readJsonObject(req));
  if (!v.ok) return fail(400, v.error);
  await savePosting(getDb(), staff, v.value);
  return NextResponse.json(await view(), { headers: { "cache-control": "no-store" } });
}
