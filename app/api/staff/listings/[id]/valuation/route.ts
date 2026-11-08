import { NextResponse } from "next/server";
import { parseOverride, valuationVisible } from "../../../../../../src/domain/valuation";
import { getDb, getDeps } from "../../../../../../src/server/context";
import { clearOverride, getOverride, getValuationSettings, setOverride } from "../../../../../../src/server/valuation-db";
import { buildValuation } from "../../../../../../src/server/valuation-service";
import { fail, readJsonObject, staffAudit, staffGate, UUID_RE } from "../../../../../../src/server/staff-route";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };
const noStore = { "cache-control": "no-store" };

async function state(id: string) {
  const db = getDb(), deps = getDeps();
  const rec = await deps.repo.get(id);
  if (!rec) return null;
  const settings = await getValuationSettings(db);
  const override = await getOverride(db, id);
  return {
    listing: { id, title: rec.listing.title, status: rec.listing.status, priceCents: rec.listing.priceCents ?? null },
    settingsEnabled: settings.enabled, override: override ?? null, visibleToBuyers: valuationVisible(settings, override),
    valuation: await buildValuation(db, rec.listing, settings, deps.now())
  };
}

/** The calculated assessment for any listing (even while it is switched off), the override and whether buyers can see it now. */
async function handleGet(req: Request, { params }: Ctx) {
  const staff = await staffGate(req, "valuation.manage");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID_RE.test(id)) return fail(404, "Listing not found.");
  const s = await state(id);
  return s ? NextResponse.json(s, { headers: noStore }) : fail(404, "Listing not found.");
}

/** Body { enabled: true | false, reason } sets "show valuation" for this listing; { enabled: null } clears it so the site setting applies. Logged. */
async function handlePost(req: Request, { params }: Ctx) {
  const staff = await staffGate(req, "valuation.manage");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID_RE.test(id)) return fail(404, "Listing not found.");
  const body = await readJsonObject(req);
  if (!body) return fail(400, "Send a JSON object.");
  const parsed = parseOverride(body);
  if (!parsed.ok) return fail(400, parsed.error);
  if (!(await getDeps().repo.get(id))) return fail(404, "Listing not found.");
  const db = getDb();
  const before = await getOverride(db, id);
  if (parsed.enabled === null) await clearOverride(db, id); else await setOverride(db, id, parsed.enabled, parsed.reason, staff.id);
  await staffAudit(staff, "listing", id, parsed.enabled === null ? "staff.valuation.override_cleared" : `staff.valuation.listing_${parsed.enabled ? "enabled" : "disabled"}`,
    { before: before ? { enabled: before.enabled, reason: before.reason } : null, after: parsed.enabled === null ? null : { enabled: parsed.enabled, reason: parsed.reason } });
  return NextResponse.json((await state(id))!, { headers: noStore });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
