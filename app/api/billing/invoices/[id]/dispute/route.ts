import { NextResponse } from "next/server";
import { parseDisputeReason } from "../../../../../../src/domain/billing-assistant";
import { getActor, getDb } from "../../../../../../src/server/context";
import { csrfGuard } from "../../../../../../src/server/csrf";
import { unauthenticated } from "../../../../../../src/server/http";
import { raiseDispute } from "../../../../../../src/server/subscription-db";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Body: { reason }. Raises a payment issue on the person's own invoice for staff to answer. One open issue per invoice. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const b = (await req.json().catch(() => null)) as { reason?: unknown } | null;
  const parsed = parseDisputeReason(b?.reason);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { id } = await params;
  const r = await raiseDispute(getDb(), actor.userId, id, parsed.reason);
  if (!r.ok) return NextResponse.json({ error: r.message }, { status: r.code === "not_found" ? 404 : 409 });
  return NextResponse.json({ id: r.id }, { status: 201 });
}

export const POST = withApi(handlePost);
