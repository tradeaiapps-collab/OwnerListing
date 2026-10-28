import { NextResponse } from "next/server";
import { buildChecklist, comboLabel } from "../../../../../src/domain/disclosure-config";
import { getDb } from "../../../../../src/server/context";
import { approvedVersionPg, listingDisclosuresPg } from "../../../../../src/server/disclosure-config-db";
import { requireListingHandler } from "../../../../../src/server/owner-listing";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/**
 * The listing's required disclosures for its state, sale or rent, use and property type, each with where it stands
 * (missing, submitted, verified, rejected). Owner or appointed agent. 423 region_not_enabled when Compliance has not approved
 * requirements for that combination yet (publishing is blocked until then).
 */
async function handleGet(req: Request, { params }: Ctx) {
  const { id } = await params;
  const handler = await requireListingHandler(req, id);
  if (handler instanceof NextResponse) return handler;
  const l = handler.rec.listing;
  const db = getDb();
  const version = await approvedVersionPg(db, l.jurisdiction, l.transactionType, l.useClass);
  if (!version) {
    return NextResponse.json({
      error: `Publishing is not available yet for ${comboLabel(l.jurisdiction, l.transactionType, l.useClass)}. Your draft is saved.`,
      code: "region_not_enabled"
    }, { status: 423 });
  }
  const items = buildChecklist(version.items, l.propertyType, l.jurisdiction, await listingDisclosuresPg(db, id));
  return NextResponse.json(
    { version: { id: version.id, version: version.version, approvedAt: version.approvedAt }, items, editable: l.status === "draft" || l.status === "pending_review" },
    { headers: { "cache-control": "no-store" } }
  );
}

export const GET = withApi(handleGet);
