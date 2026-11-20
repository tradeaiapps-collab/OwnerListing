import { NextResponse } from "next/server";
import { todayUtc } from "../../../../../src/domain/contractor-trust";
import { publicTrustPg } from "../../../../../src/server/contractor-trust-db";
import { err, ID_RE } from "../../../../../src/server/contractor-trust-route";
import { getDb } from "../../../../../src/server/context";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ no: string }> };

/** Public: the verified badge, star rating and reviews with replies. Never licence, ABN, policy or contact details. */
async function handleGet(_req: Request, { params }: Ctx) {
  const { no: id } = await params;
  if (!ID_RE.test(id)) return err(404, "Not found.");
  const trust = await publicTrustPg(getDb(), id, todayUtc());
  return trust ? NextResponse.json({ trust }, { headers: { "cache-control": "no-store" } }) : err(404, "Not found.");
}

export const GET = withApi(handleGet);
