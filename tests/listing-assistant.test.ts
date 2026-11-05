import { describe, expect, it } from "vitest";
import { scanForDiscrimination } from "../src/domain/discrimination-filter";
import {
  buildPlan, clarifyingQuestions, describeLearning, fieldTips, learnFrom, marketingAngles, nicePrice, parseFeedback, photoPlan, preferredRewriteMode,
  pricingAdvice, rewriteDescription, shorterTarget, suggestTags, syndicationPlan, type AssistantFacts, type FeedbackEvent
} from "../src/domain/listing-assistant";
import { REPORTS_NOTICE } from "../src/domain/ai-description";
import { estimatePrice, type Comparable } from "../src/domain/price-guidance";

const facts: AssistantFacts = { transactionType: "sale", propertyType: "house", suburb: "Paddington", bedrooms: 3, bathrooms: 2, parking: 1 };
const NOW = "2026-11-05T00:00:00.000Z";
const comp = (p: number, i: number): Comparable => ({ id: `c${i}`, transactionType: "sale", propertyType: "house", priceCents: p * 1_000_000, date: "2026-09-01T00:00:00.000Z", suburb: "Paddington", bedrooms: 3, bathrooms: 2, parking: 1 });
const estimate = estimatePrice(facts, [118, 120, 122, 124, 126].map(comp), NOW)!;
const ev = (kind: FeedbackEvent["kind"], key: string, action: FeedbackEvent["action"], deltaPct?: number): FeedbackEvent => ({ kind, key, action, ...(deltaPct !== undefined ? { deltaPct } : {}) });

describe("clarifying questions", () => {
  it("asks for the essentials first and at most four", () => {
    const q = clarifyingQuestions({ transactionType: "sale", propertyType: "house" });
    expect(q.map(x => x.id).slice(0, 3)).toEqual(["suburb", "bedrooms", "bathrooms"]);
    expect(q).toHaveLength(4);
    expect(q.every(x => x.question && x.why && x.target)).toBe(true);
  });
  it("skips what is already answered and asks rental questions only for rentals", () => {
    const d = "Three bedroom home with a deck, walk to the train station and shops. Renovated kitchen and bathrooms. ".repeat(3);
    const ids = clarifyingQuestions({ ...facts, priceCents: 85_000_000, description: d, photoCount: 12 }, undefined, 10).map(x => x.id);
    expect(ids).toEqual([]);
    expect(clarifyingQuestions({ ...facts, transactionType: "rent" }, undefined, 10).map(x => x.id)).toEqual(expect.arrayContaining(["furnished", "pets"]));
    expect(clarifyingQuestions(facts, undefined, 10).map(x => x.id)).not.toContain("pets");
  });
  it("stops asking an optional question after two dismissals but never an essential one", () => {
    const p = learnFrom([ev("question", "outdoor", "dismissed"), ev("question", "outdoor", "dismissed"), ev("question", "suburb", "dismissed"), ev("question", "suburb", "dismissed")]);
    const ids = clarifyingQuestions({ transactionType: "sale", propertyType: "house" }, p, 10).map(x => x.id);
    expect(ids).not.toContain("outdoor");
    expect(ids).toContain("suburb");
  });
  it("asks about photos only when the count is known and low", () => {
    expect(clarifyingQuestions({ ...facts, photoCount: 2 }, undefined, 20).map(x => x.id)).toContain("photos");
    expect(clarifyingQuestions(facts, undefined, 20).map(x => x.id)).not.toContain("photos");
  });
  it("gives a tip for every field, worded for sale or rent", () => {
    expect(fieldTips({ transactionType: "rent", propertyType: "unit" }).price).toMatch(/weekly rent/);
    expect(fieldTips({ transactionType: "sale", propertyType: "house" }).price).toMatch(/quote below/);
  });
});

describe("auto-tagging", () => {
  const text = { description: "Renovated home with a pool, solar panels and ducted air conditioning. Open plan living, walk to the train station. Not furnished.", amenities: ["pool"] };
  it("finds amenities and highlights with the words that triggered them", () => {
    const t = suggestTags(text);
    expect(t.find(x => x.id === "solar")).toMatchObject({ kind: "amenity", alreadySet: false, evidence: expect.stringMatching(/solar/i) });
    expect(t.find(x => x.id === "pool")?.alreadySet).toBe(true);
    expect(t.map(x => x.id)).toEqual(expect.arrayContaining(["air_conditioning", "renovated", "open_plan", "near_transport"]));
  });
  it("does not read 'not furnished' as furnished", () => {
    expect(suggestTags(text).some(x => x.id === "furnished")).toBe(false);
    expect(suggestTags({ description: "Fully furnished apartment" }).some(x => x.id === "furnished")).toBe(true);
  });
  it("lifts tags the author accepts and hides ones they keep skipping", () => {
    const base = suggestTags(text).find(x => x.id === "solar")!.score;
    const liked = learnFrom([ev("tag", "solar", "accepted"), ev("tag", "solar", "accepted")]);
    expect(suggestTags(text, liked).find(x => x.id === "solar")!.score).toBeGreaterThan(base);
    const skipped = learnFrom([ev("tag", "solar", "dismissed"), ev("tag", "solar", "dismissed"), ev("tag", "solar", "dismissed")]);
    expect(suggestTags(text, skipped).some(x => x.id === "solar")).toBe(false);
  });
});

describe("description rewriter", () => {
  const messy = "MUST SEE this stunning home!!! It is very close to the train station. The home is really bright and sunny. Call 0412 345 678 today. " +
    "The property boasts a renovated kitchen with stone benchtops. The kitchen is renovated with stone benchtops. This house is structurally sound. Inspect by appointment.";
  it("cleans hype, contact details, absolute claims and repeats, and says what it did", () => {
    const r = rewriteDescription(messy, "better", facts);
    if (r.state !== "ready") throw new Error(r.state);
    expect(r.text).not.toMatch(/must see|0412|structurally sound|!/i);
    expect(r.text).not.toMatch(/\b[A-Z]{4,}\b/);
    expect(r.text.match(/stone benchtops/g)).toHaveLength(1);
    expect(r.text.endsWith("Inspect by appointment.")).toBe(true);
    expect(r.text.startsWith("A 3 bedroom, 2 bathroom house in Paddington with 1 car space.")).toBe(true);
    expect(r.changes.length).toBeGreaterThanOrEqual(4);
    expect(r.label).toMatch(/AI suggestion/);
  });
  it("never adds a claim: the opening line uses only the entered details", () => {
    const r = rewriteDescription("Close to the shops.", "better", { transactionType: "rent", propertyType: "unit" });
    expect(r.state).toBe("unchanged");
  });
  it("shorter keeps the sentences with facts, the opening line and report notices", () => {
    const long = Array.from({ length: 14 }, (_, i) => `Filler sentence number ${i} about nothing in particular at all really.`).join(" ") +
      ` The kitchen has stone benchtops and a 900 mm oven. ${REPORTS_NOTICE}`;
    const r = rewriteDescription(long, "shorter", facts);
    if (r.state !== "ready") throw new Error(r.state);
    expect(r.afterWords).toBeLessThanOrEqual(100);
    expect(r.text).toContain("stone benchtops");
    expect(r.text).toContain(REPORTS_NOTICE);
    expect(r.text.startsWith("A 3 bedroom")).toBe(true);
  });
  it("drops sentences that state who may buy or rent, and refuses empty or oversized text", () => {
    const r = rewriteDescription("Sunny three bedroom home with a yard. No kids allowed.", "better", facts);
    if (r.state !== "ready") throw new Error(r.state);
    expect(scanForDiscrimination(r.text).blocked).toBe(false);
    expect(r.text).not.toMatch(/kids/i);
    expect(rewriteDescription("  ", "better", facts).state).toBe("unavailable");
    expect(rewriteDescription("x ".repeat(3000), "better", facts).state).toBe("unavailable");
  });
  it("learns the author's preferred length from how they edit the shorter version", () => {
    expect(shorterTarget(learnFrom([]))).toBe(90);
    const longer = learnFrom([ev("rewrite", "shorter", "edited", 30), ev("rewrite", "shorter", "edited", 25), ev("rewrite", "shorter", "edited", 40)]);
    expect(shorterTarget(longer)).toBeGreaterThan(90);
    const tighter = learnFrom([ev("rewrite", "shorter", "edited", -30), ev("rewrite", "shorter", "edited", -25), ev("rewrite", "shorter", "edited", -20)]);
    expect(shorterTarget(tighter)).toBeLessThan(90);
    expect(preferredRewriteMode(learnFrom([ev("rewrite", "shorter", "accepted"), ev("rewrite", "shorter", "accepted"), ev("rewrite", "shorter", "accepted"), ev("rewrite", "better", "dismissed"), ev("rewrite", "better", "dismissed"), ev("rewrite", "better", "dismissed")]))).toBe("shorter");
    expect(preferredRewriteMode(learnFrom([]))).toBe("better");
  });
});

describe("pricing strategy", () => {
  it("is unavailable, with a plain message, when there are no comparables", () => {
    expect(pricingAdvice(facts, undefined)).toMatchObject({ state: "unavailable" });
  });
  it("gives three options inside the range, never below the low estimate", () => {
    const a = pricingAdvice({ ...facts }, estimate);
    if (a.state !== "ready") throw new Error("unavailable");
    expect(a.options.map(o => o.id)).toEqual(["competitive", "market", "aspirational"]);
    for (const o of a.options) expect(o.priceCents).toBeGreaterThanOrEqual(a.lowCents);
    expect(a.options[0]!.priceCents).toBeLessThanOrEqual(a.options[1]!.priceCents);
    expect(a.options[1]!.priceCents).toBeLessThanOrEqual(a.options[2]!.priceCents);
    expect(a.recommended).toBe("market");
    expect(a.note).toMatch(/underquoting/);
  });
  it("says where the author's own price sits", () => {
    const a = (p: number) => pricingAdvice({ ...facts, priceCents: p }, estimate);
    expect((a(200_000_000) as { position: string }).position).toBe("above");
    expect((a(60_000_000) as { position: string }).position).toBe("below");
    expect((a(120_000_000) as { position: string }).position).toBe("within");
  });
  it("tucks a price just above a search step under it, but not under the floor", () => {
    expect(nicePrice("sale", 85_200_000, 80_000_000)).toBe(84_900_000);
    expect(nicePrice("sale", 85_200_000, 85_000_000)).toBe(85_200_000);
    expect(nicePrice("rent", 65_500, 60_000)).toBe(64_500);
  });
  it("follows the option the author usually picks once there is enough history and confidence", () => {
    const p = learnFrom([ev("pricing", "competitive", "chosen"), ev("pricing", "competitive", "chosen"), ev("pricing", "competitive", "chosen")]);
    const a = pricingAdvice(facts, estimate, p);
    expect(a.state === "ready" && a.recommended).toBe("competitive");
  });
});

describe("photos, angles, channels", () => {
  it("builds a shot list for the property type and extras", () => {
    const h = photoPlan({ propertyType: "house", amenities: ["pool", "solar"], bedrooms: 4, photoCount: 3 });
    expect(h.shots.map(s => s.id)).toEqual(expect.arrayContaining(["hero", "kitchen", "pool", "solar", "back"]));
    expect(h.target).toBe(12);
    expect(h.missing).toBe(9);
    expect(photoPlan({ propertyType: "unit", bedrooms: 2 }).shots.map(s => s.id)).toContain("balcony");
    expect(photoPlan({ propertyType: "land" }).shots[0]!.id).toBe("land-front");
    expect(photoPlan({ propertyType: "office" }).shots[0]!.id).toBe("com-front");
  });
  it("suggests angles from the property's features, with headlines that pass the wording filter", () => {
    const f: AssistantFacts = { ...facts, bedrooms: 4, amenities: ["pool", "garden"], description: "Pool and alfresco entertaining area, walk to the train station." };
    const angles = marketingAngles(f, suggestTags(f));
    expect(angles.map(a => a.id)).toContain("lifestyle");
    for (const a of angles) expect(scanForDiscrimination(a.headline).flags).toEqual([]);
  });
  it("always lists OwnerListing, offers short-stay portals only for furnished rentals, and sends big portals through an agent", () => {
    const sale = syndicationPlan(facts);
    expect(sale[0]!.id).toBe("platform");
    expect(sale.some(c => c.id === "short_stay")).toBe(false);
    expect(sale.find(c => c.id === "major_portals")!.status).toBe("needs_agent");
    expect(syndicationPlan({ ...facts, transactionType: "rent", amenities: ["furnished"] }).some(c => c.id === "short_stay")).toBe(true);
  });
  it("builds the whole plan in one call", () => {
    const p = buildPlan(facts, estimate);
    expect(Object.keys(p).sort()).toEqual(["angles", "channels", "learned", "photos", "pricing", "questions", "tags", "tips"]);
  });
});

describe("learning feedback", () => {
  it("accepts only the fixed vocabulary and caps the batch", () => {
    expect(parseFeedback([ev("tag", "solar", "accepted")])).toMatchObject({ ok: true });
    expect(parseFeedback([])).toMatchObject({ ok: false });
    expect(parseFeedback(Array.from({ length: 21 }, () => ev("tag", "solar", "accepted")))).toMatchObject({ ok: false });
    expect(parseFeedback([{ kind: "tag", key: "my secret text", action: "accepted" }])).toMatchObject({ ok: false });
    expect(parseFeedback([{ kind: "tag", key: "solar", action: "chosen" }])).toMatchObject({ ok: false });
    expect(parseFeedback([{ kind: "tag", key: "solar", action: "accepted", deltaPct: 5 }])).toMatchObject({ ok: false });
    expect(parseFeedback([{ kind: "nope", key: "x", action: "accepted" }])).toMatchObject({ ok: false });
  });
  it("clamps the length change", () => {
    const r = parseFeedback([{ kind: "rewrite", key: "shorter", action: "edited", deltaPct: 9999 }]);
    expect(r.ok && r.events[0]!.deltaPct).toBe(300);
  });
  it("tells the author in plain words what was learned", () => {
    expect(describeLearning(learnFrom([]))).toEqual([]);
    const lines = describeLearning(learnFrom([ev("tag", "pool", "accepted"), ev("tag", "pool", "accepted"), ev("tag", "solar", "dismissed"), ev("tag", "solar", "dismissed")]));
    expect(lines.join(" ")).toMatch(/Pool/);
    expect(lines.join(" ")).toMatch(/Solar/);
  });
});
