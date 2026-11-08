import { NextResponse } from "next/server";
import { getActor, getDb } from "../../../../src/server/context";
import { latestRate, rateHistory } from "../../../../src/server/mortgage-rates-db";
import { withApi } from "../../../../src/server/api/with-api";

/**
 * Published home-loan rate (RBA table F5, banks' standard variable, owner-occupier). Public: { latest }.
 * Agents also get ?history=<months> (default 60), newest first. Rates are public data; nothing about the visitor is stored.
 */
async function handleGet(req: Request) {
  const url = new URL(req.url);
  const history = url.searchParams.get("history");
  if (history !== null) {
    const actor = await getActor(req);
    if (!actor) return NextResponse.json({ error: "Sign in to see rate history." }, { status: 401 });
    if (actor.userType !== "agent") return NextResponse.json({ error: "Rate history is for agents." }, { status: 403 });
    return NextResponse.json({ history: await rateHistory(getDb(), Number(history)) }, { headers: { "cache-control": "no-store" } });
  }
  return NextResponse.json({ latest: await latestRate(getDb()), source: "Reserve Bank of Australia, table F5" }, { headers: { "cache-control": "public, max-age=3600" } });
}

export const GET = withApi(handleGet);
