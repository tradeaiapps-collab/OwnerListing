import { NextResponse } from "next/server";
import { canDeleteAccounts } from "../domain/account-deletion";
import type { StaffActor } from "../domain/staff-access";
import { fail, staffGate } from "./staff-route";

/** Super admin only: the sensitive permission user.delete and the super_admin role itself (a custom role holding it is refused). */
export async function deletionGate(req: Request): Promise<StaffActor | NextResponse> {
  const staff = await staffGate(req, "user.delete");
  if (staff instanceof NextResponse) return staff;
  return canDeleteAccounts(staff) ? staff : fail(403, "Not allowed.");
}
