import { NextResponse } from "next/server";
import { LISTING_ASSISTANT_RATE, windowStart, withinLimit } from "../domain/rate-limit";
import { MAX_REWRITE_INPUT, type AssistantFacts } from "../domain/listing-assistant";
import { AMENITIES, MAX_ROOMS, MAX_SUBURB_LENGTH } from "../domain/listing-details";
import type { Actor } from "../domain/listing-service";
import { getActor, getDb } from "./context";
import { csrfGuard } from "./csrf";
import { unauthenticated } from "./http";
import { countHitPg } from "./offer-flow-db";

const bad = (message: string) => NextResponse.json({ error: message }, { status: 400 });

/** Reads the listing facts the form sends. Everything is optional except the sale or rent choice; bad values are refused, not guessed. */
export function parseFacts(raw: unknown): { ok: true; facts: AssistantFacts } | { ok: false; error: string } {
  if (raw === null || typeof raw !== "object") return { ok: false, error: "Send the listing details as facts." };
  const b = raw as Record<string, unknown>;
  const tx = b["transactionType"] === "rent" ? "rent" : b["transactionType"] === "sale" ? "sale" : null;
  if (!tx) return { ok: false, error: "transactionType must be sale or rent." };
  const f: AssistantFacts = { transactionType: tx, propertyType: "house" };
  const str = (k: string, max: number): string | undefined | null => {
    const v = b[k];
    if (v === undefined || v === null || v === "") return undefined;
    return typeof v === "string" && v.length <= max ? v.trim() : null;
  };
  const num = (k: string, max: number): number | undefined | null => {
    const v = b[k];
    if (v === undefined || v === null || v === "") return undefined;
    return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max ? v : null;
  };
  const pt = str("propertyType", 20);
  if (pt === null || (pt !== undefined && !/^[a-z]+$/.test(pt))) return { ok: false, error: "Invalid property type." };
  if (pt) f.propertyType = pt;
  for (const [k, max] of [["title", 200], ["description", MAX_REWRITE_INPUT]] as const) {
    const v = str(k, max);
    if (v === null) return { ok: false, error: `${k} is too long.` };
    if (v !== undefined) f[k] = v;
  }
  const sub = str("suburb", MAX_SUBURB_LENGTH);
  if (sub === null) return { ok: false, error: "Invalid suburb." };
  if (sub !== undefined) f.suburb = sub;
  const pc = str("postcode", 4);
  if (pc === null || (pc !== undefined && !/^\d{4}$/.test(pc))) return { ok: false, error: "Invalid postcode." };
  if (pc) f.postcode = pc;
  for (const k of ["bedrooms", "bathrooms", "parking"] as const) {
    const v = num(k, MAX_ROOMS);
    if (v === null) return { ok: false, error: `Invalid ${k}.` };
    if (v !== undefined) f[k] = v;
  }
  const price = num("priceCents", 100_000_000_000);
  if (price === null) return { ok: false, error: "Invalid price." };
  if (price !== undefined && price > 0) f.priceCents = price;
  const photos = num("photoCount", 100);
  if (photos === null) return { ok: false, error: "Invalid photo count." };
  if (photos !== undefined) f.photoCount = photos;
  const am = b["amenities"];
  if (am !== undefined) {
    if (!Array.isArray(am) || am.length > AMENITIES.length || am.some(a => typeof a !== "string" || !(AMENITIES as readonly string[]).includes(a))) return { ok: false, error: "Invalid amenities." };
    f.amenities = am as string[];
  }
  return { ok: true, facts: f };
}

/** Shared by the three assistant routes: CSRF, sign-in and the per-user hourly limit. A response means stop. */
export async function assistantGate(req: Request, kind: "read" | "json" | "bare"): Promise<NextResponse | { actor: Actor; body: unknown }> {
  if (kind !== "read") {
    const blocked = csrfGuard(req, kind === "bare" ? { json: false } : {});
    if (blocked) return blocked;
  }
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (actor.userType !== "owner" && actor.userType !== "agent") return NextResponse.json({ error: "Your account cannot do this." }, { status: 403 });
  const hits = await countHitPg(getDb(), `listing-assist:${actor.userId}`, windowStart(new Date().toISOString(), LISTING_ASSISTANT_RATE.windowMs));
  if (!withinLimit(hits, LISTING_ASSISTANT_RATE.perUser)) return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429 });
  const body: unknown = kind !== "json" ? null : await req.json().catch(() => null);
  if (kind === "json" && (body === null || typeof body !== "object")) return bad("Send a JSON body.");
  return { actor, body };
}
