import { describe, expect, it } from "vitest";
import {
  agreed, bulkEligible, fitDraft, groupModeration, moderationGroupKey, moderationStaffAction, namesDisagree, recommendComplaint, recommendModeration, recommendVerification,
  type ComplaintFacts, type ModerationFacts, type VerificationFacts
} from "../src/domain/elena-prescreen";

const mod = (o: Partial<ModerationFacts> = {}): ModerationFacts => ({ id: "i1", subjectType: "message", source: "content_filter", reason: "Flagged: abuse", detail: "hello there", severity: "medium", ownerRecentRejections: 0, hasOwner: true, ...o });

describe("Elena moderation pre-screen", () => {
  it("hides blocked abuse and cites the matched word", () => {
    const r = recommendModeration(mod({ detail: "you are a stupid idiot and a moron" }));
    expect(r.action).toBe("hide");
    expect(r.confidence).toBe("high");
    expect(r.rule).toBe("mod.abuse_blocked");
    expect(r.reason).toContain("idiot");
  });
  it("only suggests suspending a repeat offender, at medium confidence at most", () => {
    const r = recommendModeration(mod({ detail: "you fucking idiot", ownerRecentRejections: 3 }));
    expect(r.action).toBe("suspend");
    expect(r.confidence).toBe("medium");
    expect(bulkEligible(r)).toBe(false);
  });
  it("hides contact details at medium confidence", () => {
    const r = recommendModeration(mod({ detail: "call me on 0412 345 678 instead" }));
    expect(r).toMatchObject({ action: "hide", confidence: "medium", rule: "mod.contact_details" });
  });
  it("approves a stale flag that no longer matches, but only for a clean account", () => {
    expect(recommendModeration(mod({ reason: "Flagged: spam", detail: "Lovely sunny kitchen with garden views" }))).toMatchObject({ action: "approve", confidence: "high", rule: "mod.no_match" });
    expect(recommendModeration(mod({ reason: "Flagged: spam", detail: "Lovely sunny kitchen", ownerRecentRejections: 1 })).action).toBe("review");
    // A contact-details or abuse flag that no longer matches (masked number, cut-short excerpt) is never cleared by Elena.
    expect(recommendModeration(mod({ reason: "Flagged: contact details", detail: "Call me on 04xx xxx xxx" })).action).toBe("review");
    expect(recommendModeration(mod({ reason: "Phone number in the description", detail: "Call me on 04xx xxx xxx" })).action).toBe("review");
    expect(recommendModeration(mod({ detail: "Lovely sunny kitchen", severity: "high" })).action).toBe("review");
  });
  it("does not guess when there is no text or the source is not the content filter", () => {
    expect(recommendModeration(mod({ source: "user_report" })).action).toBe("review");
    expect(recommendModeration(mod({ detail: null })).confidence).toBe("low");
  });
  it("groups duplicates under the oldest item", () => {
    const k = moderationGroupKey({ subjectType: "message", detail: "Call me!!", reason: "x" }, "u1");
    expect(k).toBe(moderationGroupKey({ subjectType: "message", detail: "call me", reason: "y" }, "u1"));
    expect(k).not.toBe(moderationGroupKey({ subjectType: "message", detail: "call me", reason: "y" }, "u2"));
    const g = groupModeration([{ id: "b", createdAt: "2026-01-02", groupKey: k }, { id: "a", createdAt: "2026-01-01", groupKey: k }, { id: "c", createdAt: "2026-01-03", groupKey: "z" }]);
    expect(g.get("b")).toEqual({ leadId: "a", size: 2 });
    expect(g.get("c")).toEqual({ leadId: "c", size: 1 });
  });
});

const ver = (o: Partial<VerificationFacts> = {}): VerificationFacts => ({
  businessName: "Sam Photos Pty Ltd", accountName: "Sam Lee Photos", abn: "51 824 753 556", licenceNumber: null, licenceAuthority: null, licenceExpiry: null,
  insurer: "CGU", policyNumber: "PL-882134", insuranceExpiry: "2027-09-30", trades: ["photographer"], abnUsedByOther: false, ...o
});
const TODAY = "2026-11-20";

describe("Elena contractor verification pre-screen", () => {
  it("recommends approval at high confidence when everything checks out", () => {
    const r = recommendVerification(ver(), TODAY);
    expect(r).toMatchObject({ action: "approve", confidence: "high", rule: "ver.complete" });
    expect(r.reason).toContain("cannot check the ABN register");
  });
  it("asks for a renewal when insurance has expired, with a draft that fits the note limit", () => {
    const r = recommendVerification(ver({ insuranceExpiry: "2026-10-01" }), TODAY);
    expect(r).toMatchObject({ action: "needs_info", confidence: "high", rule: "ver.insurance_expired" });
    expect(r.draft).toContain("certificate of currency");
    expect(r.draft!.length).toBeLessThanOrEqual(500);
  });
  it("flags soon-expiring insurance at medium confidence", () => {
    expect(recommendVerification(ver({ insuranceExpiry: "2026-12-20" }), TODAY)).toMatchObject({ action: "needs_info", confidence: "medium", rule: "ver.insurance_soon" });
  });
  it("catches a bad ABN checksum, a reused ABN, a placeholder policy and a missing licence for a licensed trade", () => {
    expect(recommendVerification(ver({ abn: "12345678901" }), TODAY).rule).toBe("ver.abn_invalid");
    expect(recommendVerification(ver({ abnUsedByOther: true }), TODAY).rule).toBe("ver.abn_duplicate");
    expect(recommendVerification(ver({ policyNumber: "1111" }), TODAY).rule).toBe("ver.policy_placeholder");
    expect(recommendVerification(ver({ trades: ["inspector"] }), TODAY).rule).toBe("ver.licence_missing");
  });
  it("checks the licence expiry when one is given", () => {
    const l = { licenceNumber: "L-4411", licenceAuthority: "QBCC" };
    expect(recommendVerification(ver({ ...l, licenceExpiry: "2026-01-01" }), TODAY).rule).toBe("ver.licence_expired");
    expect(recommendVerification(ver({ ...l, licenceExpiry: null }), TODAY).rule).toBe("ver.licence_no_expiry");
    expect(recommendVerification(ver({ ...l, licenceExpiry: "2028-01-01" }), TODAY).action).toBe("approve");
  });
  it("asks about a name mismatch but not about a legal suffix or a trading name that shares a word", () => {
    expect(namesDisagree("Sam Photos Pty Ltd", "Sam Lee")).toBe(false);
    expect(namesDisagree("Acme Plumbing", "Priya Nair")).toBe(true);
    const r = recommendVerification(ver({ businessName: "Acme Plumbing", accountName: "Priya Nair" }), TODAY);
    expect(r).toMatchObject({ action: "needs_info", confidence: "medium", rule: "ver.name_mismatch" });
  });
  it("medium confidence approval is not bulk eligible", () => {
    const r = recommendVerification(ver({ insuranceExpiry: "2027-03-01" }), TODAY);
    expect(r).toMatchObject({ action: "approve", confidence: "medium" });
    expect(bulkEligible(r)).toBe(false);
  });
  it("fitDraft drops whole lines instead of cutting a sentence", () => {
    const d = fitDraft("Head", Array.from({ length: 12 }, (_, i) => `Please send item number ${i} with some long explanatory text`), "Foot", 300);
    expect(d.length).toBeLessThanOrEqual(300);
    expect(d.startsWith("Head")).toBe(true);
    expect(d.endsWith("Foot")).toBe(true);
    expect(d).toContain("a few more details");
  });
});

const cmp = (o: Partial<ComplaintFacts> = {}, k: Partial<ComplaintFacts["contractor"]> = {}): ComplaintFacts => ({
  kind: "no_show", detail: "x", filedAt: "2026-11-10T00:00:00Z",
  job: { kind: "photographer", status: "approved", createdAt: "2026-11-01T00:00:00Z", scheduledTime: "2026-11-08T01:00:00Z", completedAt: null, contractorDoneAt: null },
  contractor: { jobsTotal: 5, jobsCompleted: 4, averageRating: 4.6, ratingCount: 4, suspended: false, upheldBefore: 0, dismissedBefore: 0, openOthers: 0, ...k },
  reporterEarlier: { total: 0, dismissed: 0 }, ...o
});

describe("Elena complaint pre-screen", () => {
  it("summarises the job history and suggests next steps", () => {
    const r = recommendComplaint(cmp());
    expect(r.summary!.join(" ")).toContain("5 jobs (4 completed)");
    expect(r.summary!.join(" ")).toContain("rated 4.6 from 4");
    expect(r.nextSteps!.length).toBeGreaterThan(0);
    expect(r).toMatchObject({ action: "uphold", confidence: "medium", rule: "cmp.no_show_confirmed" });
  });
  it("never recommends suspending at high confidence", () => {
    for (const r of [recommendComplaint(cmp({}, { upheldBefore: 2 })), recommendComplaint(cmp({ kind: "conduct" }, { upheldBefore: 1 }))]) {
      expect(r.action).toBe("uphold_and_suspend");
      expect(r.confidence).not.toBe("high");
    }
  });
  it("does not call it a no-show when the job was marked done", () => {
    const r = recommendComplaint(cmp({ job: { ...cmp().job, contractorDoneAt: "2026-11-08T03:00:00Z" } }));
    expect(r.action).toBe("review");
  });
  it("leaves subjective complaints to staff and suggests dismissal for a pattern of dismissed complaints", () => {
    expect(recommendComplaint(cmp({ kind: "poor_work" })).action).toBe("review");
    expect(recommendComplaint(cmp({ kind: "poor_work", reporterEarlier: { total: 2, dismissed: 2 } }))).toMatchObject({ action: "dismiss", rule: "cmp.repeat_dismissed" });
  });
  it("does not suspend someone who is already suspended", () => {
    expect(recommendComplaint(cmp({ kind: "conduct" }, { upheldBefore: 3, suspended: true })).action).toBe("review");
  });
});

describe("outcome vocabulary", () => {
  it("counts verify as approve and never agrees with a no-call", () => {
    expect(agreed("approve", "verify")).toBe(true);
    expect(agreed("needs_info", "verify")).toBe(false);
    expect(agreed("review", "approve")).toBeNull();
    expect(agreed("hide", "approve")).toBe(false);
  });
  it("maps a moderation decision to what was done", () => {
    expect(moderationStaffAction("reject", "none")).toBe("hide");
    expect(moderationStaffAction("reject", "listing")).toBe("hide");
    expect(moderationStaffAction("reject", "account")).toBe("suspend");
    expect(moderationStaffAction("escalate", "none")).toBe("escalate");
  });
});
