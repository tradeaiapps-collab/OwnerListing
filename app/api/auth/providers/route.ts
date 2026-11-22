import { NextResponse } from "next/server";
import { readAuthEnv, readSessionEnv } from "../../../../src/server/auth/config";
import { withApi } from "../../../../src/server/api/with-api";
import { getDb } from "../../../../src/server/context";
import { localDevServer } from "../../../../src/server/dev-login";
import { loadResolved } from "../../../../src/server/messaging-settings-db";

/** Which sign-in methods work right now, so the sign-in and sign-up pages show only those. Names no keys or settings. */
async function handleGet() {
  const email = readSessionEnv() !== null && ((await loadResolved(getDb(), process.env).catch(() => null))?.email != null || localDevServer());
  return NextResponse.json({ google: readAuthEnv() !== null, email, dev: process.env["DEV_LOGIN"] === "1" && localDevServer() });
}

export const GET = withApi(handleGet);
