import { NextResponse } from "next/server";
import { effectivePermissions } from "../../../../src/domain/staff-access";
import { getStaff } from "../../../../src/server/context";

/** Who the signed-in staff member is, with the role and permissions as they stand in the database now. */
export async function GET(req: Request) {
  const s = await getStaff(req);
  return NextResponse.json({ staff: s ? { id: s.id, role: s.role, permissions: effectivePermissions(s) } : null }, { headers: { "cache-control": "no-store" } });
}
