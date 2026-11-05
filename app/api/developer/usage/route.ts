import { NextResponse } from "next/server";
import { analyseUsage } from "../../../../src/domain/api-insights";
import { withPrincipal } from "../../../../src/server/api/principal";
import { getDb } from "../../../../src/server/context";
import { failingEndpointCount, usageRows } from "../../../../src/server/public-api-db";
import { withApi } from "../../../../src/server/api/with-api";

/** Elena's read of the caller's own API use over the last 7 days: counts by route and status, never request contents. */
async function handleGet(req: Request) {
  return withPrincipal(req, "listings.read", async userId => {
    const [rows, hooks] = await Promise.all([usageRows(getDb(), userId, 7), failingEndpointCount(getDb(), userId)]);
    return NextResponse.json({ days: 7, ...analyseUsage(rows, { webhookEndpoints: hooks.total, failingEndpoints: hooks.failing }) });
  });
}

export const GET = withApi(handleGet);
