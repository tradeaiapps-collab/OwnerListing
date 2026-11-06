import { describe, expect, it } from "vitest";
import type { AiEnginePort } from "../src/domain/ai-engine";
import { rulesOnlyEngine } from "../src/domain/ai-engine";
import { buildQuickSetup, extractFromNotes, parseQuickReply } from "../src/domain/quick-setup";

const NOTES = "3 bedroom house at 12 Smith Street, Paddington QLD 4064. Two bathrooms, double garage, renovated kitchen with stone benchtops, saltwater pool and a north-facing deck. Walk to the train station. Asking $1.15m.";
const engine = (reply: string | Error): AiEnginePort => ({
  info: () => ({ id: "t", kind: "self_hosted", version: "1" }),
  readDocument: async () => "", describePhoto: async () => [],
  generate: async () => { if (reply instanceof Error) throw reply; return reply; }
});

describe("extractFromNotes", () => {
  it("reads rooms, price, place, type and features from the owner's words only", () => {
    const f = extractFromNotes(NOTES);
    expect(f).toMatchObject({ transactionType: "sale", propertyType: "house", bedrooms: 3, bathrooms: 2, suburb: "Paddington", jurisdiction: "QLD", postcode: "4064", address: "12 Smith Street", priceCents: 115_000_000 });
    expect(f.amenities).toEqual(expect.arrayContaining(["pool"]));
    expect(f.title).toMatch(/3 bedroom house in Paddington/);
  });
  it("detects rent and leaves missing things blank instead of guessing", () => {
    const f = extractFromNotes("Sunny unit for rent, $650 per week, close to shops and the beach, available now.");
    expect(f).toMatchObject({ transactionType: "rent", propertyType: "unit", priceCents: 65_000 });
    expect(f.bedrooms).toBeUndefined(); expect(f.suburb).toBeUndefined();
  });
  it("honours an explicit sale or rent choice", () => { expect(extractFromNotes("Nice home per week", "sale").transactionType).toBe("sale"); });
});

describe("parseQuickReply", () => {
  it("accepts a clean reply and refuses contact details or a missing form", () => {
    expect(parseQuickReply("TITLE: Renovated home with pool\nDESCRIPTION: A bright three bedroom home with a pool.")).toEqual({ title: "Renovated home with pool", description: "A bright three bedroom home with a pool." });
    expect(parseQuickReply("TITLE: Nice\nDESCRIPTION: Call 0412 345 678 now")).toBeNull();
    expect(parseQuickReply("just some text")).toBeNull();
  });
});

describe("buildQuickSetup", () => {
  it("works with the AI off (rules only)", async () => {
    const r = await buildQuickSetup(rulesOnlyEngine, NOTES);
    expect(r.state === "ready" && r.source).toBe("rules");
    if (r.state === "ready") { expect(r.fields.bedrooms).toBe(3); expect(r.missing).toEqual([]); }
  });
  it("uses the model's title and description but never its numbers", async () => {
    const r = await buildQuickSetup(engine("TITLE: Family home with pool in Paddington\nDESCRIPTION: A renovated home with a pool and deck."), NOTES);
    expect(r.state === "ready" && r.source).toBe("ai");
    if (r.state === "ready") { expect(r.fields.title).toBe("Family home with pool in Paddington"); expect(r.fields.bedrooms).toBe(3); }
  });
  it("falls back to rules when the model fails or breaks the rules, and asks for more when the notes are too short", async () => {
    for (const e of [engine(new Error("down")), engine("TITLE: x\nDESCRIPTION: This is defect-free and perfect condition")]) {
      const r = await buildQuickSetup(e, NOTES);
      expect(r.state === "ready" && r.source).toBe("rules");
    }
    expect((await buildQuickSetup(rulesOnlyEngine, "nice")).state).toBe("unavailable");
  });
});
