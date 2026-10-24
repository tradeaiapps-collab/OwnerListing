import { NextResponse } from "next/server";

/** Liveness only: no database call, no data. Served in every APP_MODE. */
export function GET() {
  return NextResponse.json({ ok: true });
}
