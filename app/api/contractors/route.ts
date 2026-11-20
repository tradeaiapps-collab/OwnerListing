import { NextResponse } from "next/server";
import { isTrade } from "../../../src/domain/contractor-market";
import { withApi } from "../../../src/server/api/with-api";
import { searchContractors } from "../../../src/server/contractor-market-db";
import { getDb } from "../../../src/server/context";

/** Public list of contractors who published their page: ?trade=photographer|inspector|pest_control|other &area=suburb or postcode &q=name. */
async function handleGet(req: Request) {
  const u = new URL(req.url);
  const trade = u.searchParams.get("trade");
  if (trade && !isTrade(trade)) return NextResponse.json({ error: "Unknown trade." }, { status: 400 });
  const contractors = await searchContractors(getDb(), { ...(trade ? { trade } : {}), ...(u.searchParams.get("area") ? { area: u.searchParams.get("area") as string } : {}), ...(u.searchParams.get("q") ? { text: u.searchParams.get("q") as string } : {}) });
  return NextResponse.json({ contractors });
}
export const GET = withApi(handleGet);
