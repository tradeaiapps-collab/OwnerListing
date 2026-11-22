import { NextResponse } from "next/server";
import { getUploadPorts } from "../../../../src/server/context";
import { withApi } from "../../../../src/server/api/with-api";

/** Whether photo uploads work on this site right now (storage and scanner configured). No personal data; the form uses it to avoid promising photos it cannot store. */
async function handleGet() {
  const ports = getUploadPorts();
  return NextResponse.json({ photos: ports.storage.configured && ports.scanner.configured }, { headers: { "cache-control": "no-store" } });
}
export const GET = withApi(handleGet);
