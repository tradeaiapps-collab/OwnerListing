import { describe, expect, it } from "vitest";
import { rulesOnlyEngine, type AiEnginePort, type GenerateOptions } from "../src/domain/ai-engine";
import { answerGuideQuestion, GUIDE_OFFER_REFUSAL, GUIDE_SCOPE_REFUSAL, GUIDE_SYSTEM_PROMPT } from "../src/domain/guide-ai";

const fake = (out: string | Error) => {
  const calls: { prompt: string; opts?: GenerateOptions }[] = [];
  const engine: AiEnginePort = {
    info: () => ({ id: "t", kind: "self_hosted", version: "1" }), readDocument: async () => "", describePhoto: async () => [],
    generate: async (prompt, opts) => { calls.push({ prompt, ...(opts ? { opts } : {}) }); if (out instanceof Error) throw out; return out; }
  };
  return { engine, calls };
};
const ctx = (engine: AiEnginePort) => ({ engine, siteName: "Acme Homes", page: "/listings/123e4567-e89b-42d3-a456-426614174000/edit" });

describe("answerGuideQuestion", () => {
  it("answers how-to questions with the strict guide prompt and fenced question", async () => {
    const f = fake("Open My listings, then press Edit on your draft.");
    const a = await answerGuideQuestion("How do I edit my draft?", ctx(f.engine));
    expect(a).toMatchObject({ state: "ready", text: "Open My listings, then press Edit on your draft." });
    expect(f.calls[0]!.opts?.system).toBe(GUIDE_SYSTEM_PROMPT);
    expect(f.calls[0]!.prompt).toContain("<<<DATA\nHow do I edit my draft?\nDATA>>>");
    expect(f.calls[0]!.prompt).toContain("/listings/<id>/edit"); // ids are not sent
  });
  it("refuses to accept, decline or counter offers, without asking the model", async () => {
    for (const q of ["Please accept the offer from James", "decline all offers on my house", "Offer B: counter it at 900k", "Can you reject this offer for me?"]) {
      const f = fake("Done, I accepted it.");
      expect(await answerGuideQuestion(q, ctx(f.engine)), q).toEqual({ state: "refused", message: GUIDE_OFFER_REFUSAL });
      expect(f.calls).toHaveLength(0);
    }
  });
  it("refuses legal and financial advice", async () => {
    const f = fake("x");
    expect(await answerGuideQuestion("How much can I borrow?", ctx(f.engine))).toEqual({ state: "refused", message: GUIDE_SCOPE_REFUSAL });
    expect(await answerGuideQuestion("Should I sign the contract?", ctx(f.engine))).toEqual({ state: "refused", message: GUIDE_SCOPE_REFUSAL });
    expect(f.calls).toHaveLength(0);
  });
  it("empty or over-long questions are refused", async () => {
    expect((await answerGuideQuestion("  ", ctx(fake("x").engine))).state).toBe("refused");
    expect((await answerGuideQuestion("a".repeat(501), ctx(fake("x").engine))).state).toBe("refused");
  });
  it("AI off or failing = unavailable, never throws", async () => {
    expect((await answerGuideQuestion("Where are my offers?", ctx(rulesOnlyEngine))).state).toBe("unavailable");
    expect((await answerGuideQuestion("Where are my offers?", ctx(fake(new Error("boom")).engine))).state).toBe("unavailable");
  });
  it("drops answers that claim actions, give advice, leak contact details or recommend loans", async () => {
    for (const bad of ["I have accepted the offer for you.", "You should sell now.", "Email the owner at jo@example.com.", "We recommend this lender's home loan.", "x".repeat(1501)]) {
      expect((await answerGuideQuestion("How do offers work?", ctx(fake(bad).engine))).state, bad.slice(0, 30)).toBe("unavailable");
    }
  });
});
