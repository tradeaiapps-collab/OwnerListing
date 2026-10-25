import { NextResponse } from "next/server";
import { withApi } from "../../../src/server/api/with-api";

/** Liveness only: no database call, no data. Served in every APP_MODE. */
function handleGet() {
  return NextResponse.json({ ok: true });
}

export const GET = withApi(handleGet);
