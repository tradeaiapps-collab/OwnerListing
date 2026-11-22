import { describe, expect, it } from "vitest";
import { rulesOnlyEngine, type AiEnginePort } from "../src/domain/ai-engine";
import {
  GLOSSARY, answerQuestion, checkFindingsSummary, insights, missingDocuments, requestFindingsSummary, requirements, stageOf, type TxnFacts
} from "../src/domain/transaction-assistant";

const facts = (o: Partial<TxnFacts> = {}): TxnFacts => ({
  viewer: "owner", transactionType: "sale", stage: "marketing", jurisdiction: "QLD", uploadedKinds: [], generated: [], inspections: [], findings: [], awaitingMySignature: 0, ...o
});
const ask = (q: string, f = facts()) => answerQuestion(f, q);

describe("stage and requirements", () => {
  it("derives the stage", () => {
    expect(stageOf("draft", "none")).toBe("preparing");
    expect(stageOf("published", "none")).toBe("marketing");
    expect(stageOf("published", "active")).toBe("offer");
    expect(stageOf("published", "accepted")).toBe("contract");
  });
  it("asks for more as the sale progresses", () => {
    const keys = (s: TxnFacts["stage"]) => requirements(facts({ stage: s })).map(r => r.key);
    expect(keys("preparing")).not.toContain("building_inspection");
    expect(keys("marketing")).toContain("building_inspection");
    expect(keys("marketing")).not.toContain("deposit_trust_notice");
    expect(keys("contract")).toContain("deposit_trust_notice");
  });
  it("marks things done from uploads, completed inspections and signed templates", () => {
    const f = facts({ stage: "contract", uploadedKinds: ["contract", "title_search"], inspections: [{ kind: "pest", status: "completed" }],
      generated: [{ templateId: "deposit_trust_notice", state: "signed" }, { templateId: "purchase_heads_of_terms", state: "awaiting_signature" }] });
    expect(missingDocuments(f).map(r => r.key).sort()).toEqual(["building_inspection", "purchase_heads_of_terms", "seller_disclosure_summary"]);
    expect(insights(f).requiredMissing).toBe(0);
  });
  it("uses lease wording for rentals", () => {
    expect(requirements(facts({ transactionType: "rent" })).map(r => r.key)).not.toContain("title_search");
  });
});

describe("answers", () => {
  it("lists missing documents from the documents desk", () => {
    const a = ask("What documents are missing?");
    expect(a.desk).toBe("documents");
    expect(a.text).toContain("Contract of sale");
  });
  it("says when nothing is missing", () => {
    const f = facts({ stage: "preparing", uploadedKinds: ["contract", "title_search"], generated: [{ templateId: "seller_disclosure_summary", state: "draft" }] });
    expect(ask("which documents do I need", f).topic).toBe("documents_complete");
  });
  it("summarises findings from the inspection desk without advice", () => {
    const f = facts({ findings: [{ severity: "urgent", area: "Wiring", summary: "Exposed live wires" }, { severity: "minor", area: "Door", summary: "Sticks" }] });
    const a = ask("Summarise the inspection findings", f);
    expect(a.desk).toBe("inspection");
    expect(a.text).toContain("URGENT · Wiring");
    expect(a.text).toContain("can't say what a repair costs");
    expect(ask("any inspection findings?").topic).toBe("no_findings");
  });
  it("explains terms as general information", () => {
    for (const t of GLOSSARY) {
      const a = ask(`what does ${t.name.toLowerCase()} mean`);
      expect(a.topic, t.name).toBe(`term_${t.id}`);
      expect(a.text).toContain("not legal advice");
    }
  });
  it("refuses advice and personal details", () => {
    for (const q of ["Should I sign this contract?", "is this enforceable", "is the price too high", "should i waive the cooling off"]) expect(ask(q).topic, q).toBe("advice");
    expect(ask("what is the buyer's phone number").topic).toBe("privacy");
    expect(ask("give me the inspector's email").topic).toBe("privacy");
  });
  it("tells a signer what is waiting, and what to do next", () => {
    expect(ask("do I need to sign anything", facts({ awaitingMySignature: 2 })).text).toContain("2 documents");
    expect(ask("what should I do next", facts({ awaitingMySignature: 1 })).text).toMatch(/1\. Read and sign/);
    expect(ask("how complete is the paperwork").desk).toBe("insights");
  });
  it("handles empty and unknown questions", () => {
    expect(ask("   ").topic).toBe("unknown");
    expect(ask("purple monkey").topic).toBe("unknown");
  });
});

describe("AI findings summary", () => {
  const findings = [{ severity: "major" as const, area: "Roof", summary: "Cracked tiles" }];
  const engine = (text: string | Error, kind: "self_hosted" | "rules_only" = "self_hosted"): AiEnginePort => ({
    ...rulesOnlyEngine, info: () => ({ id: "t", kind, version: "1" }),
    generate: async () => { if (text instanceof Error) throw text; return text; }
  });
  it("accepts a clean summary", async () => {
    const r = await requestFindingsSummary(engine("The roof has cracked tiles that need repair soon. No other major issues were noted."), findings);
    expect(r.state).toBe("ready");
  });
  it("fails closed", async () => {
    for (const e of [engine("x"), engine("You should not buy this house because the roof is bad."), engine("Call 0412 345 678 about the roof defects found."),
      engine(new Error("down")), engine("fine summary text that is long enough", "rules_only")]) {
      expect((await requestFindingsSummary(e, findings)).state).toBe("unavailable");
    }
    expect((await requestFindingsSummary(engine("fine summary text that is long enough"), [])).state).toBe("unavailable");
    expect(checkFindingsSummary("Visit https://evil.test for the roof findings report")).toBe(false);
  });
});
