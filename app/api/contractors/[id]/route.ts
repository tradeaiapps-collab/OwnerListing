import { NextResponse } from "next/server";
import { parseContractorNumber } from "../../../../src/domain/contractor-market";
import { withApi } from "../../../../src/server/api/with-api";
import { loadPublicProfile } from "../../../../src/server/contractor-market-db";
import { getDb } from "../../../../src/server/context";

type Ctx = { params: Promise<{ id: string }> };

/** One public contractor page by contractor number (2001 or CON-2001). Aggregate job figures only. */
async function handleGet(_req: Request, { params }: Ctx) {
  const no = parseContractorNumber((await params).id);
  const profile = no === undefined ? undefined : await loadPublicProfile(getDb(), no);
  return profile ? NextResponse.json({ profile }) : NextResponse.json({ error: "Not found." }, { status: 404 });
}
export const GET = withApi(handleGet);
