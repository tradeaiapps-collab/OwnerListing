import { describe, expect, it } from "vitest";
import { analyseProposal, compareHistory, parseHistory, parseProposal, scoreComplexity, type HistoryProject, type ProposalInput } from "../src/domain/feasibility";

const base: ProposalInput = { title: "Small tweak", description: "Change the label on the enquiry button and update the copy in the help page for buyers.", timelineWeeks: 4, teamSize: 3, systemsTouched: 1, newTechnologies: [], externalDependencies: [], compliance: false, legalSignOff: false, requirements: "clear", teamHasExpertise: "yes", budgetJustified: "yes" };
const big: ProposalInput = { ...base, title: "Bank feeds", description: "Integrate the bank API and the Domain API, sync balances, also add reports, plus an audit trail with privacy consent and trust account checks. Maybe more, etc.", timelineWeeks: 2, teamSize: 1, systemsTouched: 5, newTechnologies: ["Open Banking", "Kafka"], externalDependencies: ["Bank partner", "Domain", "Counsel"], compliance: true, requirements: "unclear", teamHasExpertise: "no", budgetJustified: "no" };
const hist = (n: number, outcome: "succeeded" | "failed" = "succeeded"): HistoryProject[] => Array.from({ length: n }, (_, i) => ({ name: `p${i}`, points: 8, weeks: 2, outcome }));

describe("complexity", () => {
  it("scores a trivial change low and a sprawling one at the top of the scale", () => {
    expect(scoreComplexity(base).points).toBeLessThanOrEqual(2);
    const c = scoreComplexity(big);
    expect(c.points).toBe(21);
    expect(c.factors.length).toBeGreaterThan(3);
  });
  it("only returns scale values", () => {
    for (const t of [1, 3, 8]) for (const s of [1, 2, 4]) expect([1, 2, 3, 5, 8, 13, 21]).toContain(scoreComplexity({ ...base, systemsTouched: s, newTechnologies: ["x"].slice(0, t % 2) }).points);
  });
});

describe("risks and probability", () => {
  it("finds technical, resource, budget, timeline and dependency risks", () => {
    const a = analyseProposal(big);
    expect(new Set(a.risks.map(r => r.category))).toEqual(new Set(["technical", "resource", "budget", "timeline", "dependency"]));
    expect(a.risks.map(r => r.title)).toContain("No legal sign-off");
    expect(a.recommendations.join(" ")).toMatch(/legal sign-off/i);
    expect(a.recommendations.join(" ")).toMatch(/Reduce scope/);
  });
  it("starts near 70 and stays inside 5 to 95", () => {
    expect(analyseProposal(big).successProbability).toBe(5);
    const easy = analyseProposal(base).successProbability;
    expect(easy).toBeGreaterThan(70);
    expect(easy).toBeLessThanOrEqual(95);
  });
  it("legal sign-off removes that risk", () => {
    expect(analyseProposal({ ...big, legalSignOff: true }).risks.map(r => r.title)).not.toContain("No legal sign-off");
  });
  it("is deterministic", () => { expect(analyseProposal(big, hist(4))).toEqual(analyseProposal(big, hist(4))); });
});

describe("history comparison", () => {
  it("refuses to compare with fewer than three projects", () => {
    const c = compareHistory(8, 4, hist(2));
    expect(c.enough).toBe(false);
    expect(c.messages[0]).toMatch(/needs 3/);
  });
  it("reports similar duration, velocity and success rate", () => {
    const h = [...hist(3), { name: "x", points: 8, weeks: 2, outcome: "failed" as const }];
    const a = analyseProposal({ ...base, description: base.description + " " + "word ".repeat(70), systemsTouched: 3 }, h);
    expect(a.comparison.velocity).toBe(4);
    expect(a.comparison.teamSuccessRate).toBe(75);
    expect(a.comparison.messages.join(" ")).toMatch(/velocity is 4 points a week/);
  });
  it("a strong record nudges probability up and a weak one down", () => {
    expect(analyseProposal(base, hist(5)).successProbability).toBeGreaterThan(analyseProposal(base, hist(5, "failed")).successProbability);
  });
});

describe("input parsing", () => {
  it("accepts a good body and rejects bad ones with a readable error", () => {
    expect(parseProposal(base as unknown as Record<string, unknown>).ok).toBe(true);
    for (const bad of [null, { ...base, title: "" }, { ...base, description: "short" }, { ...base, timelineWeeks: 0 }, { ...base, teamSize: 1.5 }, { ...base, newTechnologies: "kafka" }, { ...base, requirements: "maybe" }, { ...base, compliance: "yes" }]) {
      const r = parseProposal(bad as Record<string, unknown> | null);
      expect(r.ok).toBe(false);
    }
    expect(parseHistory({ name: "A", points: 8, weeks: 2, outcome: "failed" }).ok).toBe(true);
    expect(parseHistory({ name: "A", points: 40, weeks: 2 }).ok).toBe(false);
  });
});
