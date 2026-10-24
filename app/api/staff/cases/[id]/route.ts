import { NextResponse } from "next/server";
import { getDb } from "../../../../../src/server/context";
import { getCase } from "../../../../../src/server/staff-admin-db";
import { fail, staffGate, UUID_RE } from "../../../../../src/server/staff-route";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const staff = await staffGate(req, "case.manage");
  if (staff instanceof NextResponse) return staff;
  const { id } = await ctx.params;
  const c = UUID_RE.test(id) ? await getCase(getDb(), id) : null;
  return c ? NextResponse.json({ case: c, me: staff.id }) : fail(404, "Case not found.");
}
