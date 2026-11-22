import { describe, expect, it } from "vitest";
import { applyAnswer, emptyPrefs, matchProjects, nextStep, summarisePrefs, MATCH_NOTICE, type InvestorPrefs, type MatchProject } from "../src/domain/elena-investor-match";

const P = (o: Partial<MatchProject> & { id: string }): MatchProject => ({
  title: "T", location: "Bulimba", jurisdiction: "QLD", projectType: "residential_development", stage: "approved", minimumTicketCents: 5_000_000,
  timeline: "Build 18 months.", risks: "Planning and construction risk. You can lose money.", ...o
});
const full = (o: Partial<InvestorPrefs> = {}): InvestorPrefs => ({ budgetMaxCents: 10_000_000, risk: "balanced", jurisdictions: ["QLD"], suburbs: [], timeframe: "2_4y", ...o });

describe("Elena question flow", () => {
  it("asks budget, risk, location, timeframe in order and then stops", () => {
    let p = emptyPrefs();
    const seen: (string | null)[] = [];
    for (const a of [
      { step: "budget", value: { budgetMaxCents: 5_000_000 } }, { step: "risk", value: { risk: "cautious" } },
      { step: "location", value: { jurisdictions: [], suburbs: ["Bulimba"] } }, { step: "timeframe", value: { timeframe: "flexible" } }
    ]) {
      seen.push(nextStep(p));
      const r = applyAnswer(p, a);
      if (!r.ok) throw new Error(r.error);
      p = r.value;
    }
    seen.push(nextStep(p));
    expect(seen).toEqual(["budget", "risk", "location", "timeframe", null]);
    expect(p.jurisdictions).toEqual([]);
    expect(summarisePrefs(p)).toContain("anywhere in Australia");
  });
  it("refuses bad, unknown and smuggled fields", () => {
    const e = emptyPrefs();
    for (const raw of [
      null, { step: "budget" }, { step: "nope", value: {} }, { step: "budget", value: { budgetMaxCents: 5 } }, { step: "budget", value: { budgetMaxCents: 1.5 } },
      { step: "budget", value: { budgetMaxCents: 500_000, commitmentCents: 1 } }, { step: "budget", value: { budgetMaxCents: 500_000 }, extra: 1 },
      { step: "risk", value: { risk: "reckless" } }, { step: "timeframe", value: { timeframe: "1y" } },
      { step: "location", value: { jurisdictions: ["XX"] } }, { step: "location", value: { jurisdictions: [], suburbs: ["a", "b", "c", "d", "e", "f"] } },
      { step: "location", value: { jurisdictions: [], suburbs: ["<script>x</script>"] } }
    ]) expect(applyAnswer(e, raw).ok).toBe(false);
  });
  it("can change an earlier answer without losing the others", () => {
    const r = applyAnswer(full(), { step: "risk", value: { risk: "growth" } });
    expect(r.ok && r.value.risk).toBe("growth");
    expect(r.ok && r.value.budgetMaxCents).toBe(10_000_000);
  });
});

describe("matching", () => {
  it("returns nothing until all four answers are in", () => {
    expect(matchProjects(emptyPrefs(), [P({ id: "a" })]).matches).toEqual([]);
  });
  it("excludes a minimum above budget, a stage two steps above the risk setting, and states not chosen", () => {
    const r = matchProjects(full({ risk: "cautious" }), [
      P({ id: "ok" }), P({ id: "dear", minimumTicketCents: 10_000_001 }), P({ id: "concept", stage: "concept" }), P({ id: "nsw", jurisdiction: "NSW" })
    ]);
    expect(r.matches.map(m => m.projectId)).toEqual(["ok"]);
    expect(r.excluded).toEqual({ budget: 1, risk: 1, location: 1 });
    expect(r.considered).toBe(4);
  });
  it("keeps a project one stage above the risk setting but says so, and ranks it lower", () => {
    const r = matchProjects(full({ risk: "cautious" }), [P({ id: "plan", stage: "planning" }), P({ id: "built", stage: "construction" })]);
    expect(r.matches.map(m => m.projectId)).toEqual(["built", "plan"]);
    expect(r.matches[1]!.cautions.join(" ")).toMatch(/earlier than a cautious/);
  });
  it("adds a timeframe caution when the stage usually takes longer, and never excludes on it", () => {
    const r = matchProjects(full({ risk: "growth", timeframe: "under_2y" }), [P({ id: "c", stage: "concept" })]);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]!.cautions.join(" ")).toMatch(/longer than your under 2 years/);
  });
  it("matches a chosen suburb, treats anywhere as no state filter, and caps the list at 5 in a stable order", () => {
    const many = Array.from({ length: 8 }, (_, i) => P({ id: `p${i}`, jurisdiction: i % 2 ? "NSW" : "QLD", location: i === 3 ? "Newstead" : "Bulimba" }));
    const r = matchProjects(full({ jurisdictions: [], suburbs: ["newstead"] }), many);
    expect(r.matches).toHaveLength(5);
    expect(r.matches[0]!.projectId).toBe("p3");
    expect(r.matches[0]!.reasons.join(" ")).toMatch(/includes newstead/);
    expect(matchProjects(full({ jurisdictions: [], suburbs: ["newstead"] }), many)).toEqual(r);
  });
  it("every reason quotes only the project's own figures, and the notice says it is not advice", () => {
    const m = matchProjects(full(), [P({ id: "a" })]).matches[0]!;
    expect(m.reasons[0]).toBe("Minimum $50,000 is within your budget of $100,000.");
    expect(m.ownerTimeline).toBe("Build 18 months.");
    expect(MATCH_NOTICE).toMatch(/not financial, legal or tax advice/);
    expect(JSON.stringify(m)).not.toMatch(/return|guarantee|should invest/i);
  });
});
