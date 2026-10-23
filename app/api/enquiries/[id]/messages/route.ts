import { NextResponse } from "next/server";
import { getThread, parseMessageBody, reply } from "../../../../../src/domain/enquiry-service";
import { getActor, getEnquiryDeps } from "../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../src/server/http";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const actor = getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const r = await getThread(getEnquiryDeps(), actor, id);
  return r.ok ? NextResponse.json(r.value) : failure(r);
}

export async function POST(req: Request, { params }: Ctx) {
  const actor = getActor(req);
  if (!actor) return unauthenticated();
  const body = parseMessageBody(await req.json().catch(() => null));
  if (!body.ok) return failure(body);
  const { id } = await params;
  const r = await reply(getEnquiryDeps(), actor, id, body.value);
  return r.ok ? NextResponse.json({ message: r.value }, { status: 201 }) : failure(r);
}
