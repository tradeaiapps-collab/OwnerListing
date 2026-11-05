import { NextResponse } from "next/server";
import { getDb } from "../../../../../src/server/context";
import { smsUsage } from "../../../../../src/server/sms-log";
import { staffGate } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";

/** Texts, segments and cost per month and template (messaging.settings). Cost is an estimate unless the provider reported a price. */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "messaging.settings");
  if (staff instanceof NextResponse) return staff;
  const months = Number(new URL(req.url).searchParams.get("months") ?? 3);
  return NextResponse.json({ usage: await smsUsage(getDb(), months) }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
