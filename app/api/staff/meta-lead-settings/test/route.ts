import { NextResponse } from "next/server";
import { testMetaConnection } from "../../../../../src/adapters/ad-lead-providers";
import { META_TEST_RATE } from "../../../../../src/domain/meta-lead-settings";
import { withinLimit, windowStart } from "../../../../../src/domain/rate-limit";
import { getDb } from "../../../../../src/server/context";
import { loadMetaConfig, metaConfigFingerprint, recordMetaTest } from "../../../../../src/server/meta-lead-settings-db";
import { countHitPg } from "../../../../../src/server/offer-flow-db";
import { fail, staffGate } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";

/**
 * Tests the saved connection against Meta's Graph API (Page token, and app secret when the App ID is set). The answer is stored so the screen can show
 * Connected. Limited per admin and overall (both counters fail closed; a refused attempt still counts). Not complete = nothing sent (409).
 */
async function handlePost(req: Request) {
  const staff = await staffGate(req, "ad_leads.manage");
  if (staff instanceof NextResponse) return staff;
  const db = getDb();
  const since = windowStart(new Date().toISOString(), META_TEST_RATE.windowMs);
  const mine = await countHitPg(db, `meta-test:${staff.id}`, since);
  const all = await countHitPg(db, "meta-test:all", since);
  if (!withinLimit(mine, META_TEST_RATE.perStaff) || !withinLimit(all, META_TEST_RATE.allStaff)) return fail(429, "Too many tests. Try again later.");
  const cfg = await loadMetaConfig(db, process.env);
  if (!cfg) return fail(409, "The connection is not complete. Enter the app secret, verify token and Page access token first.");
  const before = await metaConfigFingerprint(db, process.env);
  const r = await testMetaConnection(fetch, cfg);
  // The keys may have been changed while Meta was answering: then the result describes old keys and must not be shown as the current status.
  const stale = before !== (await metaConfigFingerprint(db, process.env));
  if (!stale) await recordMetaTest(db, staff, r);
  return NextResponse.json({ ok: r.ok, stale, message: stale ? "The keys changed during the test. Run Test connection again." : r.message, pageName: r.pageName, pageId: r.pageId, appChecked: r.appChecked }, { status: r.ok ? 200 : 502, headers: { "cache-control": "no-store" } });
}

export const POST = withApi(handlePost);
