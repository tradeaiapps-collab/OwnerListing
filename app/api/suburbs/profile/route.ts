import { NextResponse } from "next/server";
import { isJurisdiction } from "../../../../src/domain/jurisdiction";
import { toSuburbView } from "../../../../src/domain/suburb-data";
import { getDb } from "../../../../src/server/context";
import { getSuburbPg } from "../../../../src/server/suburb-data-db";
import { withApi } from "../../../../src/server/api/with-api";

/** Public: GET ?state=NSW&suburb=Bondi gives the loaded suburb figures with their source and date, or { view: null }. Reads only; no listing or user data. */
async function handleGet(req: Request) {
  const u = new URL(req.url);
  const state = (u.searchParams.get("state") ?? "").toUpperCase(), suburb = (u.searchParams.get("suburb") ?? "").trim();
  if (!isJurisdiction(state) || suburb.length < 1 || suburb.length > 80) return NextResponse.json({ error: "Send a state and a suburb." }, { status: 400 });
  const p = await getSuburbPg(getDb(), state, suburb);
  return NextResponse.json({ view: p ? toSuburbView(p) : null }, { headers: { "cache-control": "public, max-age=300" } });
}

export const GET = withApi(handleGet);
