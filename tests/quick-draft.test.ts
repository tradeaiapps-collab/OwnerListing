import { describe, expect, it } from "vitest";
import type { AiEnginePort } from "../src/domain/ai-engine";
import { rulesOnlyEngine } from "../src/domain/ai-engine";
import { buildQuickDraft, draftNotes, readObservations, stateChecklist, type AreaInfo } from "../src/domain/quick-draft";
import { checkEndpoint, readAiConfig } from "../src/adapters/ollama-engine";

const area: AreaInfo = { suburbFacts: [], checklist: [] };
const photo = { name: "p", mimeType: "image/jpeg", bytes: new Uint8Array([1]) };
const engine = (seen: string[] | Error, reply = "TITLE: Bright home with pool\nDESCRIPTION: A bright home with a pool."): AiEnginePort => ({
  info: () => ({ id: "t", kind: "self_hosted", version: "1" }), readDocument: async () => "",
  describePhoto: async () => { if (seen instanceof Error) throw seen; return seen; }, generate: async () => reply
});

describe("readObservations", () => {
  it("keeps plain observations, drops contact details, and maps known features", () => {
    const r = readObservations([["Kitchen", "stone benchtops", "swimming pool", "call 0412 345 678"], ["kitchen", "air conditioning"]]);
    expect(r.seen).toEqual(["Kitchen", "stone benchtops", "swimming pool", "air conditioning"]);
    expect(r.amenities).toEqual(expect.arrayContaining(["pool", "air_conditioning"]));
  });
});

describe("buildQuickDraft", () => {
  const input = { address: "12 Smith Street", suburb: "Paddington", state: "QLD", postcode: "4064", bedrooms: 3 };
  it("adds what the photos show, keeps the owner's numbers and never invents a price", async () => {
    const r = await buildQuickDraft(engine(["living room", "swimming pool"]), input, [photo], area);
    expect(r.state).toBe("ready");
    if (r.state !== "ready") return;
    expect(r.photoState).toBe("read");
    expect(r.fields.amenities).toContain("pool");
    expect(r.fields).toMatchObject({ address: "12 Smith Street", suburb: "Paddington", jurisdiction: "QLD", postcode: "4064", bedrooms: 3 });
    expect(r.fields.priceCents).toBeUndefined();
    expect(r.missing).toContain("Asking price");
  });
  it("still writes a draft when photos cannot be read or the AI is off", async () => {
    const failed = await buildQuickDraft(engine(new Error("x")), input, [photo], area);
    expect(failed.state === "ready" && failed.photoState).toBe("failed");
    const off = await buildQuickDraft(rulesOnlyEngine, input, [photo], area);
    expect(off.state === "ready" && off.photoState).toBe("off");
  });
  it("puts the owner's price in cents", async () => {
    const r = await buildQuickDraft(rulesOnlyEngine, { ...input, priceDollars: 950000 }, [], area);
    expect(r.state === "ready" && r.fields.priceCents).toBe(95_000_000);
  });
});

describe("draftNotes and stateChecklist", () => {
  it("builds a plain brief", () => { expect(draftNotes({ address: "1 A St", state: "NSW" }, ["pool"])).toContain("Seen in the photos: pool."); });
  it("lists state items for a known state and nothing otherwise", () => {
    expect(stateChecklist("NSW").length).toBeGreaterThan(0);
    expect(stateChecklist(undefined)).toEqual([]);
  });
});

describe("vision model config", () => {
  it("reads AI_VISION_MODEL and rejects a bad name", () => {
    const ok = readAiConfig({ AI_ENGINE: "ollama", AI_VISION_MODEL: "llama3.2-vision" });
    expect(ok.ok && ok.config.visionModel).toBe("llama3.2-vision");
    expect(readAiConfig({ AI_ENGINE: "ollama", AI_VISION_MODEL: "bad name!" }).ok).toBe(false);
    expect(checkEndpoint("http://127.0.0.1:11434", false).ok).toBe(true);
  });
});
