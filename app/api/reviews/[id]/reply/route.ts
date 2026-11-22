import { NextResponse } from "next/server";
import { parseReply } from "../../../../../src/domain/contractor-trust";
import { replyToReviewPg } from "../../../../../src/server/contractor-trust-db";
import { err, guardText, ID_RE, readBody, sessionActor } from "../../../../../src/server/contractor-trust-route";
import { getDb } from "../../../../../src/server/context";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** The reviewed contractor posts one public reply: { "reply": text }. It cannot be edited or removed. */
async function handlePost(req: Request, { params }: Ctx) {
  const actor = await sessionActor(req, { contractor: true, write: true });
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  if (!ID_RE.test(id)) return err(404, "Not found.");
  const r = parseReply(await readBody(req));
  if (!r.ok) return err(400, r.message);
  const g = await guardText(actor.userId, "contractor_review_reply", { reply: r.value });
  if ("response" in g) return g.response;
  if (!(await replyToReviewPg(getDb(), actor.userId, id, r.value))) return err(409, "This is not your review to reply to, or you have already replied.");
  return NextResponse.json({ ok: true });
}

export const POST = withApi(handlePost);
