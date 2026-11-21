import { NextResponse } from "next/server";
import { sendCertificate } from "../../../../../../src/server/contractor-certificate-file";
import { sessionActor } from "../../../../../../src/server/contractor-trust-route";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** A contractor downloads their own certificate file only. */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await sessionActor(req, { contractor: true });
  if (actor instanceof NextResponse) return actor;
  return sendCertificate((await params).id, actor.userId);
}
export const GET = withApi(handleGet);
