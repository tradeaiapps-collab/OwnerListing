import { NextResponse } from "next/server";
import { parseRuleInput } from "../../../../src/domain/ad-lead-routing";
import { staffCan } from "../../../../src/domain/staff-access";
import { getDb, getStaff } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { listAgents } from "../../../../src/server/ad-lead-db";
import { createRule, listRules } from "../../../../src/server/ad-lead-routing-db";
import { withApi } from "../../../../src/server/api/with-api";

const NEED_STAFF = () => NextResponse.json({ error: "Sign in as staff." }, { status: 401 });
const NOT_ALLOWED = () => NextResponse.json({ error: "Not allowed." }, { status: 403 });

/** Routing rules in the order they apply, with the agents they can name. ad_leads.manage only. */
async function handleGet(req: Request) {
  const staff = await getStaff(req);
  if (!staff) return NEED_STAFF();
  if (!staffCan(staff, "ad_leads.manage")) return NOT_ALLOWED();
  const db = getDb();
  return NextResponse.json({ rules: await listRules(db), agents: await listAgents(db) }, { headers: { "cache-control": "no-store" } });
}

/** Adds a rule: { label, sourceId?, position?, postcodes?, suburbs?, propertyTypes?, interests?, agentUserIds }. */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const staff = await getStaff(req);
  if (!staff) return NEED_STAFF();
  if (!staffCan(staff, "ad_leads.manage")) return NOT_ALLOWED();
  const parsed = parseRuleInput(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const r = await createRule(getDb(), staff.id, parsed.value, new Date().toISOString());
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  return NextResponse.json({ id: r.id }, { status: 201 });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
