import { NextResponse } from "next/server";
import { sendCertificate } from "../../../../../../../src/server/contractor-certificate-file";
import { staffAudit, staffGate } from "../../../../../../../src/server/staff-route";
import { withApi } from "../../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Staff with the licence check permission open a contractor's certificate file to compare it with the details. Every view is audited. */
async function handleGet(req: Request, { params }: Ctx) {
  const staff = await staffGate(req, "licence.verify");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  const res = await sendCertificate(id, null);
  if (res.ok) await staffAudit(staff, "contractor_certificate", id, "contractor_certificate.viewed", {}).catch(() => undefined);
  return res;
}
export const GET = withApi(handleGet);
