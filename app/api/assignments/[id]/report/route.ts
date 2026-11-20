import { NextResponse } from "next/server";
import { parseReport } from "../../../../../src/domain/contractor-trust";
import { createReportPg } from "../../../../../src/server/contractor-trust-db";
import { err, guardText, ID_RE, readBody, sessionActor } from "../../../../../src/server/contractor-trust-route";
import { getDb } from "../../../../../src/server/context";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** The owner reports the contractor on their job: { "kind": "no_show" | "poor_work" | "unsafe" | "other", "detail": text }. Goes to the staff queue. */
async function handlePost(req: Request, { params }: Ctx) {
  const actor = await sessionActor(req, { write: true });
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  if (!ID_RE.test(id)) return err(404, "Not found.");
  const r = parseReport(await readBody(req));
  if (!r.ok) return err(400, r.message);
  // Only staff read a report, so a phone number in it is allowed; abuse is still refused.
  const g = await guardText(actor.userId, "contractor_report", { detail: r.value.detail }, { ignore: ["contact_details"] });
  if ("response" in g) return g.response;
  const out = await createReportPg(getDb(), actor.userId, id, r.value.kind, r.value.detail);
  if (out === "not_allowed") return err(403, "You can report a contractor only on your own accepted or completed job.");
  if (out === "duplicate") return err(409, "You have already reported this. Staff are reviewing it.");
  return NextResponse.json({ ok: true }, { status: 201 });
}

export const POST = withApi(handlePost);
