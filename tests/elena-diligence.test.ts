import { describe, expect, it } from "vitest";
import { buildDiligence, scrubForInvestor, summaryLeaks, validateNote, type DiligenceInputDoc } from "../src/domain/elena-diligence";
import type { InvestmentProject } from "../src/domain/investor-projects";

const project = {
  id: "p1", ownerUserId: "o1", status: "approved", version: 1, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  title: "Riverside townhouses", location: "Bulimba", jurisdiction: "QLD", projectType: "residential_development", stage: "approved",
  summary: "Six townhouses close to the river.", fundingTargetCents: 250_000_000, minimumTicketCents: 5_000_000, timeline: "Build 18 months.",
  risks: "Planning and cost risk.", structureDescription: "Unit trust.", visibleTo: "all_verified", issuerName: "Riverside Dev Pty Ltd", issuerLicenceBasis: "s708", issuerStatement: "", issuerAuthorisedConfirmed: true
} as unknown as InvestmentProject;
const NOW = "2026-11-21T00:00:00.000Z";
const doc = (id: string, kind: DiligenceInputDoc["kind"], pages: string[], o: Partial<DiligenceInputDoc> = {}): DiligenceInputDoc =>
  ({ id, title: `Doc ${id}`, kind, uploadedAt: "2026-11-01T00:00:00Z", terms: [], pages, ...o });
const vis = (ds: DiligenceInputDoc[]) => ds.map(d => ({ id: d.id, kind: d.kind, uploadedAt: d.uploadedAt, title: d.title }));
const build = (ds: DiligenceInputDoc[], pending: { id: string; title: string; kind: DiligenceInputDoc["kind"] }[] = [], p = project) => buildDiligence(p, ds, pending, [...vis(ds), ...pending.map(x => ({ ...x, uploadedAt: NOW }))], NOW);

describe("Elena due-diligence engine", () => {
  it("flags missing documents for the stage, and when nothing is shared", () => {
    const s = build([doc("a", "plan", ["Site plan for six townhouses over two levels with parking and landscaping."])]);
    expect(s.missing.map(m => m.id)).toEqual(expect.arrayContaining(["missing-feasibility", "missing-approval"]));
    expect(build([]).missing[0]?.id).toBe("missing-any");
  });

  it("finds risk wording and quotes it with the document and page", () => {
    const s = build([doc("a", "approval", ["The development application is not yet approved by council.", "The approval is subject to a flood study and expires in 2027."])]);
    const ids = s.risks.map(r => r.id.split("-")[0]);
    expect(ids).toEqual(expect.arrayContaining(["approval", "conditions", "site", "expiry"]));
    const r = s.risks.find(x => x.id.startsWith("approval"))!;
    expect(r.cite).toMatchObject({ docId: "a", page: 1 });
    expect(r.quote).toContain("not yet approved");
    expect(s.risks[0]!.severity).toBe("high");
  });

  it("does not repeat return claims, only says a document has them", () => {
    const s = build([doc("a", "feasibility", ["The project is expected to deliver a 18% p.a. return to investors.", "Construction is planned over eighteen months in two stages."])]);
    expect(JSON.stringify(s)).not.toContain("18%");
    expect(s.risks.some(r => r.id.startsWith("claim-") && !r.quote)).toBe(true);
  });

  it("finds figures that disagree between documents and with the project page", () => {
    const s = build([
      doc("a", "feasibility", ["The total project cost is $4,200,000 including GST and the funding target is $2,500,000. The scheme has 6 townhouses."]),
      doc("b", "report", ["The total project cost is $4,900,000 after the latest quote.", "The scheme has 8 townhouses over two levels."])
    ]);
    const cost = s.inconsistencies.find(i => i.id === "inc-money-cost")!;
    expect(cost.detail).toContain("$4,200,000");
    expect(cost.detail).toContain("$4,900,000");
    expect(cost.severity).toBe("high");
    expect(s.inconsistencies.find(i => i.id === "inc-count-dwellings")?.detail).toMatch(/8 in Doc b/);
    expect(s.inconsistencies.some(i => i.id === "inc-money-raise")).toBe(false);
    const raise = build([doc("a", "feasibility", ["The funding target is $3,000,000 for this raise."])]);
    expect(raise.inconsistencies.some(i => i.id === "inc-money-raise")).toBe(true);
  });

  it("same figure in two places is not an inconsistency", () => {
    const s = build([doc("a", "feasibility", ["The total project cost is $4,200,000."]), doc("b", "report", ["Total project cost: $4.2 million."])]);
    expect(s.inconsistencies.find(i => i.id === "inc-money-cost")).toBeUndefined();
  });

  it("lists documents it could not read and documents still waiting for masking", () => {
    const s = build([doc("a", "plan", [])], [{ id: "z", title: "Contract draft", kind: "contract" }]);
    expect(s.notRead.map(n => n.id)).toEqual(["unread-a", "pending-z"]);
    expect(s.documents[0]!.readable).toBe(false);
    expect(s.headline).toMatch(/could not be covered/);
  });

  it("never carries an address, contact detail or owner-typed address title", () => {
    const s = build([doc("a", "approval", ["The site at 12 Smith Street, Bulimba is subject to a flood overlay. Call 0412 345 678 for the lot at 12 Smith Street.", "Approval subject to conditions on lot 14 RP 12345."], { title: "Approval 12 Smith Street", terms: ["Smith Street"] })]);
    expect(summaryLeaks(s)).toBe(false);
    expect(JSON.stringify(s)).not.toMatch(/Smith|0412|12345/);
    expect(s.documents[0]!.title).toBe("Approval document");
  });

  it("the investor copy drops anything that would leak, even from stored text", () => {
    const s = build([doc("a", "plan", ["Six townhouses with parking and landscaping are planned over two levels."])]);
    s.documents[0]!.points.push("Meet at 45 Jones Road, Bulimba");
    s.risks.push({ id: "x", severity: "low", title: "Call 0412 345 678", cite: { docId: null, title: "t", page: null } });
    const v = scrubForInvestor(s);
    expect(JSON.stringify(v)).not.toMatch(/Jones|0412/);
  });

  it("is deterministic and validates the developer note", () => {
    const ds = [doc("a", "plan", ["Six townhouses with parking and landscaping are planned over two levels."])];
    expect(build(ds)).toEqual(build(ds));
    expect(validateNote("  ").ok).toBe(true);
    expect(validateNote("x".repeat(1001)).ok).toBe(false);
    expect(validateNote("Email me at a@b.com").ok).toBe(false);
    expect(validateNote("This is guaranteed to be risk-free").ok).toBe(false);
    expect(validateNote("The site is at 12 Smith Street").ok).toBe(false);
    expect(validateNote("The council letter is due in March.")).toEqual({ ok: true, value: "The council letter is due in March." });
  });
});
