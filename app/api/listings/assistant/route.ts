import { NextResponse } from "next/server";
import { buildPlan } from "../../../../src/domain/listing-assistant";
import { estimatePrice, type Subject } from "../../../../src/domain/price-guidance";
import { withApi } from "../../../../src/server/api/with-api";
import { getDb, getDeps } from "../../../../src/server/context";
import { loadProfilePg } from "../../../../src/server/listing-assistant-db";
import { assistantGate, parseFacts } from "../../../../src/server/listing-assistant";
import { getComparablesSource } from "../../../../src/server/price-guidance";

/**
 * Elena's guidance for the listing form. Body: { facts } with what has been typed so far (nothing needs to be saved first).
 * Returns questions, field tips, tags, pricing, a photo shot list, marketing angles and where to advertise. Rules only; owners and
 * agents; per-user hourly limit. Advisory: nothing is saved or published here.
 */
async function handlePost(req: Request) {
  const gate = await assistantGate(req, "json");
  if (gate instanceof NextResponse) return gate;
  const parsed = parseFacts((gate.body as Record<string, unknown>)["facts"]);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const f = parsed.facts;
  const now = getDeps().now();
  const subject: Subject = {
    transactionType: f.transactionType, propertyType: f.propertyType,
    ...(f.suburb ? { suburb: f.suburb } : {}), ...(f.postcode ? { postcode: f.postcode } : {}),
    ...(f.bedrooms !== undefined ? { bedrooms: f.bedrooms } : {}), ...(f.bathrooms !== undefined ? { bathrooms: f.bathrooms } : {}),
    ...(f.parking !== undefined ? { parking: f.parking } : {})
  };
  // Comparables need a place to compare in; without one the pricing card says so.
  const estimate = f.suburb || f.postcode ? estimatePrice(subject, await getComparablesSource().find(subject, now), now) : undefined;
  const profile = await loadProfilePg(getDb(), gate.actor.userId);
  return NextResponse.json(buildPlan(f, estimate, profile), { headers: { "cache-control": "no-store" } });
}

export const POST = withApi(handlePost);
