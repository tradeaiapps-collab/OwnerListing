import { NextResponse } from "next/server";
import { buildOwnerReport } from "../../../../../src/domain/reports";
import { getDb } from "../../../../../src/server/context";
import { failure } from "../../../../../src/server/http";
import { requireListingOwner } from "../../../../../src/server/owner-listing";
import { loadOwnerReport } from "../../../../../src/server/reports-db";
import { withApi } from "../../../../../src/server/api/with-api";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One listing's enquiry and offer counts. Anyone who is not the owner gets 404. */
async function handleGet(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return failure({ ok: false, code: "not_found", message: "Listing not found." });
  const owned = await requireListingOwner(req, id);
  if (owned instanceof NextResponse) return owned;
  return NextResponse.json({ report: buildOwnerReport(await loadOwnerReport(getDb(), owned.actor.userId, id)) });
}

export const GET = withApi(handleGet);
