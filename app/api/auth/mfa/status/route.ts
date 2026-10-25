import { NextResponse } from "next/server";
import { readBrand } from "../../../../../src/config/brand";
import { unauthenticated } from "../../../../../src/server/http";
import { mfaStatus } from "../../../../../src/server/mfa";
import { getMfaDeps, getSessionState } from "../../../../../src/server/mfa-context";
import { withApi } from "../../../../../src/server/api/with-api";

/** What the MFA page shows: whether a check is required and passed, which methods are set up and which can be offered. */
async function handleGet(req: Request) {
  const s = await getSessionState(req);
  if (!s) return unauthenticated();
  return NextResponse.json(await mfaStatus(await getMfaDeps(), s, readBrand().name), { headers: { "cache-control": "private, no-store" } });
}

export const GET = withApi(handleGet);
