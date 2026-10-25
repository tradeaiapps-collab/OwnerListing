import { NextResponse } from "next/server";
import { getDb } from "../../../../../src/server/context";
import { loadGuideView, publishGuide } from "../../../../../src/server/guide-assistant-db";
import { NO_STORE, readBoundedJson, versionOrNull } from "../../../../../src/server/site-route";
import { fail, staffGate } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";

/** Makes the reviewed draft version live (turning the guide on or off is part of the content). Body: { version }. */
async function handlePost(req: Request) {
  const staff = await staffGate(req, "site.content.publish");
  if (staff instanceof NextResponse) return staff;
  const body = await readBoundedJson(req, 1024);
  if (body instanceof NextResponse) return body;
  const version = versionOrNull(body["version"]);
  if (typeof version !== "number") return fail(400, "version must be the draft version you reviewed.");
  const db = getDb();
  const out = await publishGuide(db, staff, version);
  if (!out.ok) return fail(out.code === "conflict" ? 409 : 404, out.error);
  return NextResponse.json(await loadGuideView(db), { headers: NO_STORE });
}

export const POST = withApi(handlePost);
