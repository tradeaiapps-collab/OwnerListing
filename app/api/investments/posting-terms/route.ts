import { NextResponse } from "next/server";
import { posterText } from "../../../../src/domain/investment-terms";
import { getInvestmentDeps } from "../../../../src/server/investments-db";
import { investGate, ok } from "../../../../src/server/investment-route";

/** The poster-facing text for the posting model in force now (shown on the new-project form). */
export async function GET(req: Request) {
  const deps = getInvestmentDeps();
  const actor = await investGate(req, deps);
  if (actor instanceof NextResponse) return actor;
  const s = await deps.postingSettings().catch(() => null);
  return s ? ok({ model: s.model, text: posterText(s) }) : NextResponse.json({ error: "Posting is not available right now." }, { status: 503 });
}
