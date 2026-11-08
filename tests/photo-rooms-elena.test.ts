import { describe, expect, it } from "vitest";
import { categoriesIn, checkLayoutChange, layoutWithUpload, viewsFor, type Layout, type PhotoRecord } from "../src/domain/listing-photos";
import { checkCaptionSuggestions, parseCaptionReply, suggestPhotoCaptions } from "../src/domain/ai-photo-captions";
import { rulesOnlyEngine, type AiEnginePort } from "../src/domain/ai-engine";

const rec = (id: string): PhotoRecord => ({ id, listingId: "L", kind: "photo", uploadedBy: "o", contentType: "image/jpeg", width: 2000, height: 1500, variants: [] });
const photos = new Map(["a", "b"].map(i => [i, rec(i)]));
const cur: Layout = { version: 1, tourUrl: null, entries: [{ photoId: "a", caption: "", alt: "", hidden: false }, { photoId: "b", caption: "", alt: "", hidden: false }] };
const facts = { transactionType: "sale", propertyType: "house", title: "Home", suburb: "Bulimba", bedrooms: 3 } as const;
const engine = (reply: string): AiEnginePort => ({ ...rulesOnlyEngine, info: () => ({ id: "t", kind: "self_hosted", version: "1" }), generate: async () => reply });

describe("rooms and features in the gallery layout", () => {
  it("accepts a room and clean feature tags, and drops duplicates", () => {
    const r = checkLayoutChange(cur, photos, { entries: [
      { photoId: "b", caption: "", alt: "", category: "kitchen", features: ["Stone benchtop", "stone benchtop", " gas cooktop "] },
      { photoId: "a", caption: "", alt: "" }] }, { everPublished: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entries[0]).toMatchObject({ photoId: "b", category: "kitchen", features: ["Stone benchtop", "gas cooktop"] });
    if (r.ok) expect(r.entries[1]).not.toHaveProperty("category");
  });
  it("refuses unknown rooms, too many or overlong features", () => {
    const e = (x: object) => checkLayoutChange(cur, photos, { entries: [{ photoId: "a", caption: "", alt: "", ...x }, { photoId: "b", caption: "", alt: "" }] }, { everPublished: true });
    expect(e({ category: "dungeon" }).ok).toBe(false);
    expect(e({ features: ["1", "2", "3", "4", "5", "6"] }).ok).toBe(false);
    expect(e({ features: ["x".repeat(41)] }).ok).toBe(false);
    expect(e({ features: "pool" }).ok).toBe(false);
  });
  it("views carry the room; a replacement keeps it; the filter counts rooms", () => {
    const l: Layout = { ...cur, entries: [{ ...cur.entries[0]!, category: "kitchen", features: ["x"] }, { ...cur.entries[1]!, category: "kitchen" }] };
    const v = viewsFor(l, photos, false);
    expect(v[0]).toMatchObject({ category: "kitchen", features: ["x"] });
    expect(categoriesIn(v)).toEqual([{ key: "kitchen", label: "Kitchen", count: 2 }]);
    expect(layoutWithUpload(l, "n", "a")[0]).toMatchObject({ photoId: "n", category: "kitchen", features: ["x"] });
    expect(viewsFor(cur, photos, false)[0]).toMatchObject({ category: "", features: [] });
  });
});

describe("Elena photo captions", () => {
  const reply = JSON.stringify([{ id: "a", caption: "Kitchen with a stone benchtop", features: ["Stone benchtop"] }]);
  it("returns checked suggestions and skips photos with nothing to go on", async () => {
    const r = await suggestPhotoCaptions(engine(`Here you go:\n\`\`\`json\n${reply}\n\`\`\``), facts, [{ photoId: "a", category: "kitchen" }, { photoId: "b" }]);
    expect(r).toMatchObject({ state: "ready", skipped: ["b"], suggestions: [{ photoId: "a", caption: "Kitchen with a stone benchtop" }] });
  });
  it("is unavailable when AI is off, errors, or nothing passes", async () => {
    expect((await suggestPhotoCaptions(rulesOnlyEngine, facts, [{ photoId: "a", category: "kitchen" }])).state).toBe("unavailable");
    expect((await suggestPhotoCaptions(engine("not json"), facts, [{ photoId: "a", category: "kitchen" }])).state).toBe("unavailable");
    const boom: AiEnginePort = { ...engine(""), generate: async () => { throw new Error("x"); } };
    expect((await suggestPhotoCaptions(boom, facts, [{ photoId: "a", category: "kitchen" }])).state).toBe("unavailable");
    expect((await suggestPhotoCaptions(engine(reply), facts, [{ photoId: "a" }])).state).toBe("unavailable");
  });
  it("drops unasked ids, absolute claims, contact details and links", () => {
    const raw = parseCaptionReply(JSON.stringify([
      { id: "a", caption: "Defect-free kitchen", features: [] },
      { id: "b", caption: "Call 0412 345 678", features: [] },
      { id: "zzz", caption: "Other listing photo", features: [] },
      { id: "c", caption: "Lounge", features: ["see www.example.com"] },
      { id: "d", caption: "Sunny lounge room", features: ["Timber floor"] }]));
    expect(checkCaptionSuggestions(raw, new Set(["a", "b", "c", "d"])).map(s => s.photoId)).toEqual(["d"]);
  });
  it("sends the room and note as fenced data and never asks beyond 12 photos", async () => {
    let seen = "";
    const spy: AiEnginePort = { ...engine(reply), generate: async p => { seen = p; return reply; } };
    const many = Array.from({ length: 20 }, (_, i) => ({ photoId: i === 0 ? "a" : `p${i}`, category: "living" }));
    await suggestPhotoCaptions(spy, facts, many);
    expect(seen).toContain("<<<DATA");
    expect((seen.match(/"id"/g) ?? []).length).toBe(12);
  });
});
