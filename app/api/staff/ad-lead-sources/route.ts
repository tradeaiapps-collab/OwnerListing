import { NextResponse } from "next/server";
import { parseSourceInput } from "../../../../src/domain/ad-leads";
import { staffCan } from "../../../../src/domain/staff-access";
import { getDb, getStaff } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { createSource } from "../../../../src/server/ad-lead-db";
import { withApi } from "../../../../src/server/api/with-api";

/** Connects an ad account. A Google source's webhook key is in this answer only; it is stored as a hash. */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const staff = await getStaff(req);
  if (!staff) return NextResponse.json({ error: "Sign in as staff." }, { status: 401 });
  if (!staffCan(staff, "ad_leads.manage")) return NextResponse.json({ error: "Not allowed." }, { status: 403 });
  const parsed = parseSourceInput(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const r = await createSource(getDb(), staff.id, parsed.value, new Date().toISOString());
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  return NextResponse.json({ id: r.id, webhookKey: r.webhookKey }, { status: 201, headers: { "cache-control": "no-store" } });
}

export const POST = withApi(handlePost);
