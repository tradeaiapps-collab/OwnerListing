import { NextResponse } from "next/server";
import { domainConfig } from "../../../../src/adapters/feed-providers";
import { parseConnectionInput } from "../../../../src/domain/property-feed";
import { staffCan } from "../../../../src/domain/staff-access";
import { getDb, getStaff } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { createConnection, listConnections } from "../../../../src/server/property-feed-db";
import { withApi } from "../../../../src/server/api/with-api";

const NEED_STAFF = () => NextResponse.json({ error: "Sign in as staff." }, { status: 401 });
const NOT_ALLOWED = () => NextResponse.json({ error: "Not allowed." }, { status: 403 });
const NO_STORE = { "cache-control": "no-store" };

/** Feed connections with their last run, and whether the Domain key is set (names only). feeds.manage only. */
async function handleGet(req: Request) {
  const staff = await getStaff(req);
  if (!staff) return NEED_STAFF();
  if (!staffCan(staff, "feeds.manage")) return NOT_ALLOWED();
  return NextResponse.json({ connections: await listConnections(getDb()), domainConfigured: domainConfig(process.env) !== null, cronConfigured: (process.env["FEED_CRON_SECRET"] ?? "").length >= 32 }, { headers: NO_STORE });
}

/** Adds a connection. A CRM feed's push token is in this answer only; it is stored as a hash. */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const staff = await getStaff(req);
  if (!staff) return NEED_STAFF();
  if (!staffCan(staff, "feeds.manage")) return NOT_ALLOWED();
  const parsed = parseConnectionInput(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const r = await createConnection(getDb(), staff.id, parsed.value, new Date().toISOString());
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  return NextResponse.json({ id: r.id, pushToken: r.pushToken }, { status: 201, headers: NO_STORE });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
