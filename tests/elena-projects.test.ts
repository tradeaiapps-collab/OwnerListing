import { describe, expect, it } from "vitest";
import {
  ADDRESS_WITHHELD, answerQuestion, classifyQuestion, draftUpdate, maskText, projectPassages, reviewProject, toPassages, validateQuestion, validateReply, validateUpdate,
  type ReviewDoc
} from "../src/domain/elena-projects";
import type { InvestmentProject } from "../src/domain/investor-projects";

const project = (o: Partial<InvestmentProject> = {}): InvestmentProject => ({
  id: "p1", ownerUserId: "o1", status: "approved", version: 1, createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z",
  terms: {} as InvestmentProject["terms"], title: "Riverside townhouses", location: "Bulimba", jurisdiction: "QLD", projectType: "residential_development",
  summary: "Six townhouses close to the river with a shared garden.", stage: "planning", fundingTargetCents: 250_000_000, minimumTicketCents: 5_000_000,
  timeline: "DA lodged. Build takes 18 months.", risks: "Planning, construction cost and sales risk. You can lose money.", structureDescription: "Unit trust with a corporate trustee.",
  visibleTo: "all_verified", issuerName: "Riverside Dev Pty Ltd", issuerLicenceBasis: "Wholesale offer under s708", issuerStatement: "", issuerAuthorisedConfirmed: true, ...o
});
const doc = (o: Partial<ReviewDoc> = {}): ReviewDoc => ({
  id: "d1", projectId: "p1", kind: "feasibility", visibility: "investors", title: "Feasibility study", uploadedBy: "o1", contentType: "application/pdf", sizeBytes: 10,
  uploadedAt: "2026-11-01T00:00:00.000Z", masking: "confirmed", ...o
});
const NOW = "2026-11-20T00:00:00.000Z";

describe("masking", () => {
  it("hides street addresses, lot plans and staff-entered terms", () => {
    const t = maskText("The site at 12 Smith Street, Bulimba QLD 4171 is Lot 7 on SP 123456. Known as Harbour House.", ["Harbour House"]);
    expect(t).not.toMatch(/Smith|4171|SP 123456|Harbour/);
    expect(t).toContain(ADDRESS_WITHHELD);
  });
});

describe("question handling", () => {
  it("classifies commitments, advice, address and contact questions", () => {
    expect(classifyQuestion("Can you reserve a unit for me?")).toBe("commit");
    expect(classifyQuestion("Should I invest? Is it a good investment?")).toBe("advice");
    expect(classifyQuestion("How much will I make in 3 years")).toBe("advice");
    expect(classifyQuestion("What is the exact address?")).toBe("address");
    expect(classifyQuestion("What's the owner's phone number")).toBe("contact");
    expect(classifyQuestion("What is the minimum amount?")).toBe("ok");
  });
  it("validates length, contact details and abuse", () => {
    expect(validateQuestion("hi").ok).toBe(false);
    expect(validateQuestion("x".repeat(501)).ok).toBe(false);
    expect(validateQuestion("Call me on 0412 345 678 about the build").ok).toBe(false);
    expect(validateQuestion("email me at bob@example.com please").ok).toBe(false);
    expect(validateQuestion("When does construction start?")).toEqual({ ok: true, value: "When does construction start?" });
  });
});

describe("answers", () => {
  const passages = [
    ...projectPassages(project()),
    ...toPassages("d1", "Feasibility study", 3, "Construction cost is estimated at $4,200,000 including contingency. The site is at 12 Smith Street, Bulimba QLD 4171.", []),
    ...toPassages("d1", "Feasibility study", 5, "Council approval is expected in March 2027. Contact the builder on 0412 345 678.", [])
  ];
  it("quotes the source with its document and page, and every figure comes from a quote", () => {
    const a = answerQuestion("What is the construction cost estimate?", passages);
    expect(a.outcome).toBe("answered");
    expect(a.sources[0]).toMatchObject({ title: "Feasibility study", page: 3 });
    expect(a.text).toContain("$4,200,000");
    expect(a.text).toContain("page 3");
    for (const n of a.text.match(/\$[\d,]+/g) ?? []) expect(a.sources.some(s => s.quote.includes(n))).toBe(true);
  });
  it("never shows the masked address or contact details", () => {
    const a = answerQuestion("What does the feasibility study say about the site and construction cost?", passages);
    expect(a.text).not.toMatch(/Smith|4171/);
    const b = answerQuestion("When is council approval expected?", passages);
    expect(b.text).not.toMatch(/0412/);
  });
  it("answers project page figures", () => {
    const a = answerQuestion("What is the minimum ticket and funding target?", passages);
    expect(a.outcome).toBe("answered");
    expect(a.text).toContain("$50,000");
    expect(a.text).toContain("$2,500,000");
  });
  it("passes on what is not in the documents instead of guessing", () => {
    const a = answerQuestion("What is the builder's insurance excess?", passages);
    expect(a.outcome).toBe("escalated");
    expect(a.sources).toHaveLength(0);
  });
  it("declines returns, advice and commitments; sends address and contact requests to the owner", () => {
    expect(answerQuestion("Will I make 20% a year, is it guaranteed?", passages)).toMatchObject({ outcome: "declined", sources: [] });
    expect(answerQuestion("Reserve me a unit and I will transfer money", passages).outcome).toBe("declined");
    expect(answerQuestion("What is the exact address?", passages)).toMatchObject({ outcome: "escalated", reason: "address_withheld" });
    expect(answerQuestion("What is the owner's email?", passages)).toMatchObject({ outcome: "escalated", reason: "contact_request" });
  });
});

describe("keeping the project current", () => {
  it("flags documents missing for the stage, stale reports and quiet projects", () => {
    const f = reviewProject(project({ stage: "construction" }), [doc({ kind: "report", uploadedAt: "2026-02-01T00:00:00.000Z", title: "Q1 report" })], undefined, NOW);
    const ids = f.map(x => x.id);
    expect(ids).toContain("missing-plan");
    expect(ids).toContain("missing-approval");
    expect(ids).not.toContain("missing-report");
    expect(ids).toContain("stale-d1");
    expect(ids).toContain("quiet-docs");
    expect(ids).toContain("no-update");
  });
  it("is quiet for a current, complete project, and notes documents waiting for masking", () => {
    const docs = [doc({ id: "a", kind: "plan" }), doc({ id: "b", kind: "feasibility" }), doc({ id: "c", kind: "approval", masking: "pending", title: "DA approval" })];
    const f = reviewProject(project({ stage: "approved" }), docs, "2026-11-10T00:00:00.000Z", NOW);
    expect(f.map(x => x.id)).toEqual(["masking-c"]);
  });
  it("drafts an update with quoted sentences only, addresses hidden, nothing for no documents", () => {
    expect(draftUpdate(project(), [], NOW)).toBeUndefined();
    const d = draftUpdate(project(), [{ id: "d9", title: "Council approval", kind: "approval", uploadedAt: "2026-11-18T00:00:00.000Z", terms: [],
      text: "Council has approved the development application for 12 Smith Street, Bulimba QLD 4171. Conditions must be met within 24 months. Call the planner on 0412 345 678." }], NOW)!;
    expect(d.sourceDocIds).toEqual(["d9"]);
    expect(d.body).toContain("Council approval");
    expect(d.body).not.toMatch(/Smith|4171|0412/);
    expect(validateUpdate(d).ok).toBe(true);
  });
  it("refuses owner edits with addresses, contact details or promised returns", () => {
    const ok = { title: "Approval received", body: "Council approval has been received and the build starts next quarter." };
    expect(validateUpdate(ok).ok).toBe(true);
    expect(validateUpdate({ ...ok, body: "We start at 12 Smith Street next quarter, approval is in." }).ok).toBe(false);
    expect(validateUpdate({ ...ok, body: "Email me at bob@example.com for approval details." }).ok).toBe(false);
    expect(validateUpdate({ ...ok, body: "Returns are guaranteed once approval is received." }).ok).toBe(false);
    expect(validateUpdate({ title: "x", body: "short" }).ok).toBe(false);
    expect(validateReply("Yes, approval is expected in March.").ok).toBe(true);
    expect(validateReply("It is at 12 Smith Street").ok).toBe(false);
  });
});
