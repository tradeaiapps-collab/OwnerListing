import { NextResponse } from "next/server";
import { getDb } from "../../../../../src/server/context";
import { deleteHolidayPg } from "../../../../../src/server/public-holidays-db";
import { fail, staffAudit, staffGate, UUID_RE } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";

/** Removes a holiday. Cases raised earlier keep the figures they were saved with. Logged. */
async function handleDelete(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const staff = await staffGate(req, "holiday.manage");
  if (staff instanceof NextResponse) return staff;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return fail(404, "Holiday not found.");
  const h = await deleteHolidayPg(getDb(), id);
  if (!h) return fail(404, "Holiday not found.");
  await staffAudit(staff, "public_holiday", id, "staff.public_holiday_removed", { state: h.state, date: h.date, name: h.name });
  return NextResponse.json({ ok: true });
}

export const DELETE = withApi(handleDelete);
