import { NextResponse } from "next/server";
import { failure } from "../../../../../src/server/http";
import { openSlots, repo } from "../../../../../src/server/open-inspection-service";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Free open inspection slots (next 28 days) for a published listing. Public: looking needs no sign-in, booking does. */
async function handleGet(_req: Request, { params }: Ctx) {
  const r = await openSlots(repo(), (await params).id, new Date().toISOString());
  return r.ok ? NextResponse.json(r.value, { headers: { "cache-control": "no-store" } }) : failure(r);
}

export const GET = withApi(handleGet);
