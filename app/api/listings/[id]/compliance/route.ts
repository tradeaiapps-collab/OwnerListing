import { NextResponse } from "next/server";
import { getListing } from "../../../../../src/domain/listing-service";
import { toComplianceView, listingReference } from "../../../../../src/domain/listing-compliance";
import { getActor, getDb, getDeps } from "../../../../../src/server/context";
import { failure } from "../../../../../src/server/http";
import { listingComplianceFactsPg } from "../../../../../src/server/listing-compliance-db";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Public compliance and safety facts for a listing: who handles the sale, whether deposits go to a verified
 * solicitor trust account, and which disclosures staff have verified. Same visibility as the listing itself.
 */
async function handleGet(req: Request, { params }: Ctx) {
  const { id } = await params;
  const deps = getDeps();
  const r = await getListing(deps, await getActor(req), id);
  if (!r.ok) return failure(r);
  const facts = await listingComplianceFactsPg(getDb(), r.value);
  const view = toComplianceView(facts, deps.now().slice(0, 10));
  return NextResponse.json({ compliance: { ...view, reference: listingReference(id) } });
}

export const GET = withApi(handleGet);
