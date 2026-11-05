import { NextResponse } from "next/server";
import { LEAD_LIMITS, mapGoogleLead } from "../../../../../../src/domain/lead-ads";
import { getDb } from "../../../../../../src/server/context";
import { ingestLead, sourceForGoogle } from "../../../../../../src/server/lead-db";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Google Ads lead form webhook: POST /api/webhooks/leads/google/{sourceId}. Google does not sign requests; it echoes the key staff
 * entered in the lead form's webhook settings as google_key in the body, which must match the key issued for this source.
 * Wrong id, wrong key and a paused source all answer the same 401. A form we cannot read answers 400 (Google shows it in its test tool).
 */
async function handlePost(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (Number(req.headers.get("content-length") ?? "0") > LEAD_LIMITS.maxWebhookBytes) return NextResponse.json({ error: "Too large." }, { status: 413 });
  const raw = await req.text();
  if (raw.length > LEAD_LIMITS.maxWebhookBytes) return NextResponse.json({ error: "Too large." }, { status: 413 });
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: "Bad request." }, { status: 400 }); }
  const mapped = mapGoogleLead(body);
  const db = getDb();
  const source = await sourceForGoogle(db, id, mapped.googleKey ?? "");
  if (!source) return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  if (!mapped.lead.ok) return NextResponse.json({ error: mapped.lead.error }, { status: 400 });
  const r = await ingestLead(db, source, mapped.lead.value, new Date().toISOString(), process.env);
  return NextResponse.json({ ok: true, created: r.created });
}

export const POST = withApi(handlePost);
