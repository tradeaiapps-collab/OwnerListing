import { NextResponse } from "next/server";
import { parseQuoteDecision } from "../../../../src/domain/contractor-trust";
import { decideQuotePg } from "../../../../src/server/contractor-trust-db";
import { err, ID_RE, readBody, sessionActor } from "../../../../src/server/contractor-trust-route";
import { getDb } from "../../../../src/server/context";
import { withApi } from "../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Body: { "action": "accept" | "decline" | "withdraw" }. The owner accepts or declines; the contractor withdraws. Only while the quote is waiting. */
async function handlePost(req: Request, { params }: Ctx) {
  const actor = await sessionActor(req, { write: true });
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  if (!ID_RE.test(id)) return err(404, "Not found.");
  const a = parseQuoteDecision(await readBody(req));
  if (!a.ok) return err(400, a.message);
  if (!(await decideQuotePg(getDb(), actor.userId, id, a.value))) return err(409, "This quote is not waiting for your decision.");
  return NextResponse.json({ ok: true });
}

export const POST = withApi(handlePost);
