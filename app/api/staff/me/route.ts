import { NextResponse } from "next/server";
import { effectivePermissions } from "../../../../src/domain/staff-access";
import { getDb, getStaff } from "../../../../src/server/context";
import { getRole } from "../../../../src/server/staff-roles-db";
import { withApi } from "../../../../src/server/api/with-api";

/** Who the signed-in staff member is, with the role (key and label) and permissions as they stand in the database now. */
async function handleGet(req: Request) {
  const s = await getStaff(req);
  const roleLabel = s ? ((await getRole(getDb(), s.role))?.label ?? s.role) : null;
  return NextResponse.json({ staff: s ? { id: s.id, role: s.role, roleLabel, permissions: effectivePermissions(s) } : null }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
