import { NextResponse } from "next/server";
import { confirmPhoneVerification } from "../../../../../src/domain/phone-verification";
import { getActor, getPhoneDeps } from "../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../src/server/http";

export async function POST(req: Request) {
  const actor = getActor(req);
  if (!actor) return unauthenticated();
  const body = (await req.json().catch(() => null)) as { code?: unknown } | null;
  const r = await confirmPhoneVerification(getPhoneDeps(), actor, body?.code);
  return r.ok ? NextResponse.json(r.value) : failure(r);
}
