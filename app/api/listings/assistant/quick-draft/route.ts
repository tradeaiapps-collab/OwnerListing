import { NextResponse } from "next/server";
import { isJurisdiction } from "../../../../../src/domain/jurisdiction";
import { PHOTO_LIMITS } from "../../../../../src/domain/listing-photos";
import { buildQuickDraft, MAX_DRAFT_PHOTOS, stateChecklist, type AreaInfo, type DraftInput } from "../../../../../src/domain/quick-draft";
import { MAX_QUICK_NOTES } from "../../../../../src/domain/quick-setup-limits";
import { AI_DESCRIPTION_RATE, withinLimit, windowStart } from "../../../../../src/domain/rate-limit";
import { toSuburbView } from "../../../../../src/domain/suburb-data";
import { withApi } from "../../../../../src/server/api/with-api";
import { getAiEngine } from "../../../../../src/server/ai";
import { getDb } from "../../../../../src/server/context";
import { assistantGate } from "../../../../../src/server/listing-assistant";
import { countHitPg } from "../../../../../src/server/offer-flow-db";
import { getSuburbPg } from "../../../../../src/server/suburb-data-db";

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const bad = (message: string) => NextResponse.json({ error: message }, { status: 400 });

function text(form: FormData, key: string, max: number): string {
  const v = form.get(key);
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}
function whole(form: FormData, key: string, max: number): number | undefined | "bad" {
  const s = text(form, key, 12);
  if (s === "") return undefined;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 && n <= max ? n : "bad";
}

/**
 * Write the whole listing. multipart/form-data: address (required), suburb, state, postcode, notes, transactionType, bedrooms, bathrooms,
 * parking, price, and up to six "photos" files. Elena looks at the photos (self-hosted vision model), adds the suburb figures and the state
 * checklist we hold, and returns a draft. Nothing is saved or stored: the owner reviews it on the form. Rate limited per user.
 */
async function handlePost(req: Request) {
  const gate = await assistantGate(req, "bare");
  if (gate instanceof NextResponse) return gate;
  let form: FormData;
  try { form = await req.formData(); } catch { return bad("Invalid upload."); }
  const address = text(form, "address", 300);
  if (address.length < 5) return bad("Enter the property's address first.");
  const tx = text(form, "transactionType", 4);
  if (tx !== "" && tx !== "sale" && tx !== "rent") return bad("transactionType must be sale or rent.");
  const state = text(form, "state", 3).toUpperCase();
  if (state !== "" && !isJurisdiction(state)) return bad("Choose a valid state.");
  const bedrooms = whole(form, "bedrooms", 30), bathrooms = whole(form, "bathrooms", 30), parking = whole(form, "parking", 30), price = whole(form, "price", 999_999_999);
  if ([bedrooms, bathrooms, parking, price].includes("bad")) return bad("Rooms, parking and price must be whole numbers.");
  const files = form.getAll("photos").filter((f): f is File => typeof f !== "string");
  if (files.length > MAX_DRAFT_PHOTOS) return bad(`Elena reads up to ${MAX_DRAFT_PHOTOS} photos at a time.`);
  const photos: { name: string; mimeType: string; bytes: Uint8Array }[] = [];
  for (const f of files) {
    if (!IMAGE_TYPES.includes(f.type) || f.size === 0 || f.size > PHOTO_LIMITS.maxBytes) return bad(`${f.name}: use a JPEG, PNG or WebP under ${PHOTO_LIMITS.maxBytes / 1_000_000} MB.`);
    photos.push({ name: f.name.replace(/^.*[\\/]/, "").slice(0, 80), mimeType: f.type, bytes: new Uint8Array(await f.arrayBuffer()) });
  }
  const hits = await countHitPg(getDb(), `ai-desc:${gate.actor.userId}`, windowStart(new Date().toISOString(), AI_DESCRIPTION_RATE.windowMs));
  if (!withinLimit(hits, AI_DESCRIPTION_RATE.perUser)) return NextResponse.json({ error: "Too many suggestions. Try again later." }, { status: 429 });

  const suburb = text(form, "suburb", 80), postcode = text(form, "postcode", 4);
  const input: DraftInput = {
    address, ...(suburb ? { suburb } : {}), ...(state ? { state } : {}), ...(postcode ? { postcode } : {}),
    ...(text(form, "notes", MAX_QUICK_NOTES) ? { notes: text(form, "notes", MAX_QUICK_NOTES) } : {}), ...(tx ? { transactionType: tx } : {}),
    ...(typeof bedrooms === "number" ? { bedrooms } : {}), ...(typeof bathrooms === "number" ? { bathrooms } : {}),
    ...(typeof parking === "number" ? { parking } : {}), ...(typeof price === "number" ? { priceDollars: price } : {})
  };
  const area: AreaInfo = { suburbFacts: [], checklist: stateChecklist(state || undefined) };
  if (state && suburb) {
    try {
      const p = await getSuburbPg(getDb(), state, suburb);
      const view = p ? toSuburbView(p) : null;
      if (view) { area.suburbFacts = view.facts; area.suburbSource = `${view.source}, as at ${view.asAt}`; }
    } catch { /* area facts are optional */ }
  }
  const result = await buildQuickDraft(await getAiEngine(), input, photos, area);
  return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
}

export const POST = withApi(handlePost);
