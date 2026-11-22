import { NextResponse } from "next/server";
import { getDb } from "../../../../../src/server/context";
import { accuracyPg } from "../../../../../src/server/elena-prescreen-db";
import { staffGate } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";

/** How often staff agreed with each of Elena's pre-screening rules (?days=30). Senior reviewers only, because it shows staff behaviour. */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "moderation.resolve_escalated");
  if (staff instanceof NextResponse) return staff;
  const days = Number(new URL(req.url).searchParams.get("days") ?? 30);
  return NextResponse.json({ days, rules: await accuracyPg(getDb(), days) }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
