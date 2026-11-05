import { NextResponse } from "next/server";
import { testDomainConnection } from "../../../../../src/adapters/feed-providers";
import { staffCan } from "../../../../../src/domain/staff-access";
import { getDb, getStaff } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import {
  deleteDomainCredentials, getCredentialStatus, parseDomainCredentials, recordTestResult, resolveDomainConfig, saveDomainCredentials
} from "../../../../../src/server/provider-credentials-db";
import { withApi } from "../../../../../src/server/api/with-api";

const NEED_STAFF = () => NextResponse.json({ error: "Sign in as staff." }, { status: 401 });
const NOT_ALLOWED = () => NextResponse.json({ error: "Not allowed." }, { status: 403 });
const NO_STORE = { "cache-control": "no-store" };

/** Domain connection status. The secret is never returned. feeds.manage only. */
async function handleGet(req: Request) {
  const staff = await getStaff(req);
  if (!staff) return NEED_STAFF();
  if (!staffCan(staff, "feeds.manage")) return NOT_ALLOWED();
  return NextResponse.json({ status: await getCredentialStatus(getDb(), "domain", process.env) }, { headers: NO_STORE });
}

/**
 * {action:"save", clientId, clientSecret} stores the keys and checks them with Domain straight away.
 * {action:"test"} re-checks the keys in use. {action:"disconnect"} removes the stored keys.
 */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const staff = await getStaff(req);
  if (!staff) return NEED_STAFF();
  if (!staffCan(staff, "feeds.manage")) return NOT_ALLOWED();
  const db = getDb();
  const body = (await req.json().catch(() => ({}))) as { action?: unknown };
  const now = new Date().toISOString();
  switch (body.action) {
    case "save": {
      const p = parseDomainCredentials(body);
      if (!p.ok) return NextResponse.json({ error: p.error }, { status: 400 });
      const saved = await saveDomainCredentials(db, staff.id, p.clientId, p.clientSecret, process.env, now);
      if (!saved.ok) return NextResponse.json({ error: saved.error }, { status: 503 });
      const test = await testDomainConnection(fetch, await resolveDomainConfig(db, process.env));
      await recordTestResult(db, "domain", test.ok, test.ok ? null : test.error, now);
      return NextResponse.json({ test, status: await getCredentialStatus(db, "domain", process.env) }, { headers: NO_STORE });
    }
    case "test": {
      const test = await testDomainConnection(fetch, await resolveDomainConfig(db, process.env));
      await recordTestResult(db, "domain", test.ok, test.ok ? null : test.error, now);
      return NextResponse.json({ test, status: await getCredentialStatus(db, "domain", process.env) }, { headers: NO_STORE });
    }
    case "disconnect": {
      const removed = await deleteDomainCredentials(db, staff.id, now);
      return NextResponse.json({ removed, status: await getCredentialStatus(db, "domain", process.env) }, { headers: NO_STORE });
    }
    default:
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
