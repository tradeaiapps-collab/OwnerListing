import { NextResponse } from "next/server";
import { getActor } from "../../../../src/server/context";
import { withApi } from "../../../../src/server/api/with-api";

async function handleGet(req: Request) {
  const a = await getActor(req);
  return NextResponse.json({ user: a ? { id: a.userId, userType: a.userType } : null });
}

export const GET = withApi(handleGet);
