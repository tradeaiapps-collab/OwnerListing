import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFileComparablesSource } from "../src/adapters/comparables-file";
import { rulesOnlyEngine, type AiEnginePort } from "../src/domain/ai-engine";
import { estimatePrice, explainEstimate, parseComparables, weightedQuantile, type Comparable, type Subject } from "../src/domain/price-guidance";
import { getComparablesSource } from "../src/server/price-guidance";

const NOW = "2026-10-25T00:00:00.000Z";
const subject: Subject = { transactionType: "sale", propertyType: "house", suburb: "Paddington", postcode: "4064", bedrooms: 3, bathrooms: 2, parking: 1 };
let n = 0;
const comp = (o: Partial<Comparable> = {}): Comparable => ({
  id: `c${++n}`, transactionType: "sale", propertyType: "house", priceCents: 120_000_000, date: "2026-08-01T00:00:00.000Z",
  suburb: "Paddington", postcode: "4064", bedrooms: 3, bathrooms: 2, parking: 1, ...o
});
const engine = (reply: string | Error): AiEnginePort => ({
  info: () => ({ id: "ollama:t", kind: "self_hosted", version: "1" }), readDocument: async () => "", describePhoto: async () => [],
  generate: async () => { if (reply instanceof Error) throw reply; return reply; }
});

describe("price estimate (rules)", () => {
  const five = [115, 118, 120, 122, 126].map(p => comp({ priceCents: p * 1_000_000 }));
  it("gives a rounded low, mid and high range from nearby recent results", () => {
    const e = estimatePrice(subject, five, NOW)!;
    expect(e.midCents).toBe(120_000_000);
    expect(e.lowCents).toBeLessThan(e.midCents);
    expect(e.highCents).toBeGreaterThan(e.midCents);
    for (const v of [e.lowCents, e.midCents, e.highCents]) expect(v % 500_000).toBe(0);
    expect(e.confidence).toBeGreaterThan(0.5);
    expect(e.comparables).toHaveLength(5);
    expect(e.modelVersion).toBe("comparables-v1");
  });
  it("is deterministic and keeps at least a 3% range either side", () => {
    expect(estimatePrice(subject, five, NOW)).toEqual(estimatePrice(subject, five, NOW));
    const same = [1, 2, 3].map(() => comp());
    const e = estimatePrice(subject, same, NOW)!;
    // About 3% each side, after rounding to $5,000.
    expect((e.midCents - e.lowCents) / e.midCents).toBeGreaterThanOrEqual(0.025);
    expect((e.highCents - e.midCents) / e.midCents).toBeGreaterThanOrEqual(0.025);
  });
  it("adjusts for bedrooms, bathrooms and parking", () => {
    const bigger = [1, 2, 3].map(() => comp({ bedrooms: 4 }));
    const e = estimatePrice(subject, bigger, NOW)!;
    expect(e.comparables[0]!.adjustedCents).toBe(110_400_000); // one bedroom fewer: -8%
  });
  it("uses only the same kind of deal, property group and area, and nothing from the future", () => {
    const noise = [
      comp({ transactionType: "rent", priceCents: 80_000 }), comp({ propertyType: "unit" }), comp({ suburb: "Toowong", postcode: "4066" }),
      comp({ date: "2027-01-01T00:00:00.000Z" }), comp({ distanceKm: 4, suburb: "Paddington" })
    ];
    expect(estimatePrice(subject, noise, NOW)).toBeUndefined();
    expect(estimatePrice(subject, [...noise, ...five], NOW)!.comparables).toHaveLength(5);
    expect(estimatePrice({ ...subject, propertyType: "townhouse" }, five, NOW)).toBeUndefined();
  });
  it("uses distance when the source knows it (1.5 km)", () => {
    const far = [1, 2, 3].map(() => comp({ suburb: "Elsewhere", postcode: "4000", distanceKm: 1.2 }));
    expect(estimatePrice(subject, far, NOW)).toBeDefined();
    expect(estimatePrice(subject, far.map(c => ({ ...c, distanceKm: 1.6 })), NOW)).toBeUndefined();
  });
  it("widens to 12 months with lower confidence when recent results are few", () => {
    const old = [1, 2, 3].map(() => comp({ date: "2026-01-15T00:00:00.000Z" }));
    const e = estimatePrice(subject, old, NOW)!;
    expect(e.basis.join(" ")).toMatch(/Older results/);
    expect(e.confidence).toBeLessThan(estimatePrice(subject, [1, 2, 3].map(() => comp()), NOW)!.confidence);
    expect(estimatePrice(subject, [comp({ date: "2025-06-01T00:00:00.000Z" }), comp(), comp()], NOW)).toBeUndefined();
  });
  it("is unavailable with fewer than 3 comparables or when they disagree wildly", () => {
    expect(estimatePrice(subject, [comp(), comp()], NOW)).toBeUndefined();
    expect(estimatePrice(subject, [], NOW)).toBeUndefined();
    const wild = [20, 60, 120, 240, 400].map(p => comp({ priceCents: p * 1_000_000, date: "2026-02-01T00:00:00.000Z" }));
    expect(estimatePrice(subject, wild, NOW)).toBeUndefined();
  });
  it("rent rounds to $10 a week", () => {
    const rents = [62, 64, 65, 66].map(p => comp({ transactionType: "rent", priceCents: p * 1_000 }));
    const e = estimatePrice({ ...subject, transactionType: "rent" }, rents, NOW)!;
    expect(e.midCents % 1_000).toBe(0);
  });
  it("weighted quantile", () => {
    expect(weightedQuantile([{ v: 1, w: 1 }, { v: 2, w: 1 }, { v: 3, w: 1 }], 0.5)).toBe(2);
    expect(weightedQuantile([{ v: 1, w: 10 }, { v: 2, w: 1 }], 0.5)).toBe(1);
  });
});

describe("comparables sources", () => {
  it("drops bad rows instead of guessing", () => {
    const rows = parseComparables([
      { id: "a", transactionType: "sale", propertyType: "house", priceCents: 100, date: "2026-01-01", suburb: "X", bedrooms: 3, postcode: "4064" },
      { id: "b", transactionType: "lease", propertyType: "house", priceCents: 100, date: "2026-01-01", suburb: "X" },
      { id: "c", transactionType: "sale", propertyType: "house", priceCents: -5, date: "2026-01-01", suburb: "X" },
      { id: "d", transactionType: "sale", propertyType: "house", priceCents: 100, date: "not a date", suburb: "X" },
      { id: "e", transactionType: "sale", propertyType: "house", priceCents: 100, date: "2026-01-01", suburb: "X", bedrooms: 2.5, postcode: "abc" },
      null, "x"
    ]);
    expect(rows.map(r => r.id)).toEqual(["a", "e"]);
    expect(rows[1]).not.toHaveProperty("bedrooms");
    expect(rows[1]).not.toHaveProperty("postcode");
    expect(parseComparables({ not: "an array" })).toEqual([]);
  });
  it("no source configured means no comparables; a file source reads and validates the file; a bad file gives none", async () => {
    expect(getComparablesSource({}).id).toBe("none");
    expect(await getComparablesSource({}).find(subject, NOW)).toEqual([]);
    const dir = await mkdtemp(path.join(tmpdir(), "comps-"));
    const f = path.join(dir, "c.json");
    await writeFile(f, JSON.stringify([comp(), comp(), { bad: true }]));
    const src = getComparablesSource({ PRICE_DATA_SOURCE: "file", PRICE_DATA_FILE: f });
    expect(src.id).toBe("file");
    expect(await src.find(subject, NOW)).toHaveLength(2);
    await writeFile(path.join(dir, "bad.json"), "{nope");
    expect(await createFileComparablesSource(path.join(dir, "bad.json")).find(subject, NOW)).toEqual([]);
    expect(await createFileComparablesSource(path.join(dir, "missing.json")).find(subject, NOW)).toEqual([]);
  });
});

describe("AI explanation", () => {
  const e = estimatePrice(subject, [115, 118, 120, 122, 126].map(p => comp({ priceCents: p * 1_000_000 })), NOW)!;
  const mid = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", minimumFractionDigits: 0 }).format(e.midCents / 100);
  it("is off without AI and on errors", async () => {
    expect(await explainEstimate(rulesOnlyEngine, e, "sale")).toEqual({ state: "unavailable" });
    expect(await explainEstimate(engine(new Error("x")), e, "sale")).toEqual({ state: "unavailable" });
  });
  it("passes plain words using only the estimate's amounts", async () => {
    expect(await explainEstimate(engine(`Five recent nearby sales put the middle of the range at ${mid}.`), e, "sale")).toMatchObject({ state: "ready", promptVersion: "price-explainer@1" });
  });
  it.each([
    "Similar homes sold for about $1,500,000.",
    "You should list it at the middle of the range.",
    "We recommend a quick sale.",
    "Call 0412 345 678 for a valuation.",
    "With this you can borrow $900,000."
  ])("drops %s", async text => {
    expect(await explainEstimate(engine(text), e, "sale")).toEqual({ state: "unavailable" });
  });
});
