import { NextResponse } from "next/server";
import { decidePublish } from "../../../../src/domain/publish";
import { isJurisdiction } from "../../../../src/domain/jurisdiction";
import { getRequiredDisclosureKeys } from "../../../../src/config/disclosures";
import type { PropertyListing } from "../../../../src/domain/listing";

const TX = ["sale", "rent"] as const;
const USE = ["residential", "commercial"] as const;
const OWNER_TYPES = ["owner", "agent"] as const;

/** Dry-run publish check. Saves nothing. Licence records are not connected yet, so agents are always blocked. */
export async function POST(req: Request) {
  const b = await req.json().catch(() => null);
  if (
    !b || typeof b.title !== "string" || typeof b.address !== "string" ||
    typeof b.jurisdiction !== "string" || !isJurisdiction(b.jurisdiction) ||
    !OWNER_TYPES.includes(b.ownerUserType) || !TX.includes(b.transactionType) || !USE.includes(b.useClass)
  ) {
    return NextResponse.json({ error: "Invalid input." }, { status: 400 });
  }

  const required = getRequiredDisclosureKeys(b.jurisdiction, b.transactionType, b.useClass);
  if (required === null) {
    return NextResponse.json({
      allowed: false,
      reasons: [`No compliance-approved disclosure configuration for ${b.jurisdiction} ${b.transactionType} (${b.useClass}) yet.`]
    });
  }

  const now = new Date().toISOString();
  const listing: PropertyListing = {
    id: "dry-run", ownerUserId: "dry-run", ownerUserType: b.ownerUserType,
    jurisdiction: b.jurisdiction, status: "draft", title: b.title,
    propertyType: b.useClass === "commercial" ? "office" : "house", useClass: b.useClass,
    transactionType: b.transactionType, address: b.address,
    disclosures: [], createdAt: now, updatedAt: now
  };
  return NextResponse.json(decidePublish(listing, required, [], now.slice(0, 10)));
}
