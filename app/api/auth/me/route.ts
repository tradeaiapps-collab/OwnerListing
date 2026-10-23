import { NextResponse } from "next/server";
import { getActor } from "../../../../src/server/context";

export async function GET(req: Request) {
  const a = getActor(req);
  return NextResponse.json({ user: a ? { id: a.userId, userType: a.userType } : null });
}
