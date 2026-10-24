import { NextResponse } from "next/server";
import { toCsv } from "../../../../../src/domain/reports";
import { ACCESS_REVIEW_HEADER, accessReviewRows } from "../../../../../src/domain/staff-roles";
import { getDb } from "../../../../../src/server/context";
import { listActiveAccess, listRoles } from "../../../../../src/server/staff-roles-db";
import { staffAudit, staffGate } from "../../../../../src/server/staff-route";

/**
 * Access review export (CSV): every active staff member with each permission they hold now. Staff managers only. Cells are
 * formula-neutralised. The export itself is audited with the row count only (no emails in the audit log).
 */
export async function GET(req: Request) {
  const staff = await staffGate(req, "staff.manage");
  if (staff instanceof NextResponse) return staff;
  const db = getDb();
  const access = await listActiveAccess(db);
  const rows = accessReviewRows(access, await listRoles(db));
  await staffAudit(staff, "staff_session", staff.id, "staff.access_exported", { staff: access.length, rows: rows.length });
  return new NextResponse(toCsv(ACCESS_REVIEW_HEADER, rows), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="staff-access-review.csv"', "cache-control": "no-store" }
  });
}
