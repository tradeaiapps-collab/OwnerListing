import { NextResponse } from "next/server";
import { parseMessageBody, startEnquiry } from "../../../../../src/domain/enquiry-service";
import { getActor, getEnquiryDeps } from "../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../src/server/http";

type Ctx = { params: Promise<{ id: string }> };

/** A verified buyer messages the owner of a published listing. */
export async function POST(req: Request, { params }: Ctx) {
  const actor = getActor(req);
  if (!actor) return unauthenticated();
  const body = parseMessageBody(await req.json().catch(() => null));
  if (!body.ok) return failure(body);
  const { id } = await params;
  const r = await startEnquiry(getEnquiryDeps(), actor, id, body.value);
  return r.ok ? NextResponse.json(r.value, { status: 201 }) : failure(r);
}
