import { NextResponse } from "next/server";
import { getDb } from "../../../../../src/server/context";
import { providerHealth } from "../../../../../src/server/providers/health";
import { lastSyncs } from "../../../../../src/server/providers/store-db";
import { staffGate } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";

/**
 * Provider readiness for staff with config.edit: key status per provider (names only, never values) and the last sync run.
 * ?probe=1 also makes one live call to MLS and Zillow with the real key, so it is staff-only and never cached.
 */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "config.edit");
  if (staff instanceof NextResponse) return staff;
  const probe = new URL(req.url).searchParams.get("probe") === "1";
  const [providers, syncs] = await Promise.all([providerHealth(process.env, { probe }), lastSyncs(getDb())]);
  return NextResponse.json({ providers, lastSyncs: syncs }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
