import { NextResponse } from "next/server";
import { todayUtc } from "../../../../../src/domain/contractor-trust";
import { getDb } from "../../../../../src/server/context";
import { listVerificationsPg } from "../../../../../src/server/contractor-trust-db";
import { staffGate } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";

/** Contractor details waiting for a check (?view=all adds decided ones, so expired insurance can be found). */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "licence.verify");
  if (staff instanceof NextResponse) return staff;
  const view = new URL(req.url).searchParams.get("view") === "all" ? "all" : "pending";
  return NextResponse.json({ verifications: await listVerificationsPg(getDb(), view, todayUtc()) }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
