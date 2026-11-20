import { NextResponse } from "next/server";
import { parseQuote } from "../../../../../src/domain/contractor-trust";
import { sendQuotePg } from "../../../../../src/server/contractor-trust-db";
import { err, guardText, ID_RE, readBody, sessionActor } from "../../../../../src/server/contractor-trust-route";
import { getDb } from "../../../../../src/server/context";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** The contractor on an accepted job sends a written quote: { "amountCents": number, "description": text }. One waits for the owner at a time. */
async function handlePost(req: Request, { params }: Ctx) {
  const actor = await sessionActor(req, { contractor: true, write: true });
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  if (!ID_RE.test(id)) return err(404, "Not found.");
  const q = parseQuote(await readBody(req));
  if (!q.ok) return err(400, q.message);
  const g = await guardText(actor.userId, "job_quote", { description: q.value.description });
  if ("response" in g) return g.response;
  const r = await sendQuotePg(getDb(), actor.userId, id, q.value);
  if (r === "not_allowed") return err(403, "You can send a quote only on an accepted job, and only while your account is in good standing.");
  if (r === "pending_exists") return err(409, "A quote is already waiting for the owner. Withdraw it first to send a new one.");
  return NextResponse.json({ ok: true }, { status: 201 });
}

export const POST = withApi(handlePost);
