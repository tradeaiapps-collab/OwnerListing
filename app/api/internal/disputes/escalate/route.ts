import { NextResponse } from "next/server";
import { authorizeCron } from "../../../../../src/server/cron-secret-db";
import { getDb } from "../../../../../src/server/context";
import { escalateOverdue } from "../../../../../src/server/dispute-db";
import { withApi } from "../../../../../src/server/api/with-api";

/**
 * Sends disputes still with the buyer and owner after 5 days to staff. Called by a scheduler with header x-cron-secret, about hourly.
 * FAILS CLOSED like the other jobs: 503 while paused or without a secret, 401 on any mismatch. (Disputes are also escalated when anyone opens the list.)
 */
async function handlePost(req: Request) {
  const auth = await authorizeCron(getDb(), "disputes", req.headers.get("x-cron-secret"));
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  return NextResponse.json(await escalateOverdue(getDb()));
}

export const POST = withApi(handlePost);
