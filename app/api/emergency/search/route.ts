import { NextResponse } from "next/server";
import { isTrade, searchEmergency } from "../../../../src/domain/emergency";
import { withApi } from "../../../../src/server/api/with-api";
import { getActor, getDb } from "../../../../src/server/context";
import { candidatesPg, profileCardsPg } from "../../../../src/server/emergency-db";
import { unauthenticated } from "../../../../src/server/http";

/** Signed-in search of emergency contractors. Contact details are shown only to signed-in people, so they cannot be scraped. Query: trade, suburb, postcode. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const q = new URL(req.url).searchParams;
  const trade = q.get("trade");
  const suburb = q.get("suburb")?.trim().slice(0, 80) || undefined;
  const postcode = /^\d{4}$/.test(q.get("postcode")?.trim() ?? "") ? q.get("postcode")!.trim() : undefined;
  const now = new Date().toISOString();
  const found = searchEmergency(await candidatesPg(getDb(), isTrade(trade) ? trade : undefined), { ...(isTrade(trade) ? { trade } : {}), suburb, postcode }, now).slice(0, 50);
  const cards = await profileCardsPg(getDb(), found.map(r => r.userId));
  return NextResponse.json({
    results: found.map(r => ({
      // The contractor's public page from the job board, when they published one: number, rating, completed jobs, photo and a recent testimonial.
      card: cards.get(r.userId) ?? null,
      id: r.userId, name: r.profile.businessName ?? r.displayName, trade: r.profile.trade, availableNow: r.availableNow, callOutCents: r.profile.callOutCents,
      hours: r.profile.allHours ? "All hours, every day" : r.profile.windows, timeZone: r.profile.timeZone, phone: r.profile.contactPhone, email: r.profile.contactEmail,
      note: r.profile.note, suburbs: r.profile.serviceSuburbs.slice(0, 12), postcodes: r.profile.servicePostcodes.slice(0, 12)
    }))
  });
}

export const GET = withApi(handleGet);
