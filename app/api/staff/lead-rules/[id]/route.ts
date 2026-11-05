import { NextResponse } from "next/server";
import { staffCan } from "../../../../../src/domain/staff-access";
import { getDb, getStaff } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { setRule } from "../../../../../src/server/lead-routing-db";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** {action:"enable"|"disable"|"delete"}. leads.manage only; audited. */
async function handlePost(req: Request, ctx: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const staff = await getStaff(req);
  if (!staff) return NextResponse.json({ error: "Sign in as staff." }, { status: 401 });
  if (!staffCan(staff, "leads.manage")) return NextResponse.json({ error: "Not allowed." }, { status: 403 });
  const { id } = await ctx.params;
  const { action } = (await req.json().catch(() => ({}))) as { action?: unknown };
  if (action !== "enable" && action !== "disable" && action !== "delete") return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  if (!(await setRule(getDb(), staff.id, id, action, new Date().toISOString()))) return NextResponse.json({ error: "Rule not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export const POST = withApi(handlePost);
