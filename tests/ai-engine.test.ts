import { describe, expect, it } from "vitest";
import { isEngineUsable, rulesOnlyEngine } from "../src/domain/ai-engine";

describe("AI engine", () => {
  it("is off until a self-hosted model is installed", async () => {
    expect(isEngineUsable(rulesOnlyEngine)).toBe(false);
    await expect(rulesOnlyEngine.generate("x")).rejects.toThrow(/No AI engine/);
  });
  it("accepts a self-hosted engine", () => {
    expect(isEngineUsable({ ...rulesOnlyEngine, info: () => ({ id: "local", kind: "self_hosted", version: "1" }) })).toBe(true);
  });
});
