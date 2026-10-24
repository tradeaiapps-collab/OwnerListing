import { NextResponse } from "next/server";
import { INVESTMENT_CONTRACT } from "../../../../src/config/investment-contract";
import { getInvestmentDeps } from "../../../../src/server/investments-db";
import { investGate } from "../../../../src/server/investment-route";

/** The DRAFT agreement template as a plain-text download. Fixed text from config: no one's details, no file metadata. */
export async function GET(req: Request) {
  const deps = getInvestmentDeps();
  const actor = await investGate(req, deps);
  if (actor instanceof NextResponse) return actor;
  return new NextResponse(INVESTMENT_CONTRACT.text, {
    headers: {
      "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename="${INVESTMENT_CONTRACT.filename}"`,
      "x-content-type-options": "nosniff", "cache-control": "no-store"
    }
  });
}
