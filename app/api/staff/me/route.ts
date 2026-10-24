import { NextResponse } from "next/server";
import { getStaff } from "../../../../src/server/context";

/** Who the signed-in staff member is, with the role as it stands in the database now. */
export async function GET(req: Request) {
  const s = await getStaff(req);
  return NextResponse.json({ staff: s ? { id: s.id, role: s.role } : null });
}
