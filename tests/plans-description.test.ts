import { describe, expect, it } from "vitest";
import { DEFAULT_PLANS, canUploadKind, hasFeature, quote, withinPhotoLimit, type Subscription } from "../src/domain/plans";
import { ADVERSE_NOTICE, REPORTS_NOTICE, checkDescription } from "../src/domain/ai-description";
import type { DocumentRecord } from "../src/domain/documents";

const [basic, standard] = DEFAULT_PLANS as [typeof DEFAULT_PLANS[0], typeof DEFAULT_PLANS[0], typeof DEFAULT_PLANS[0]];
const now = "2026-10-22T00:00:00.000Z";
const sub: Subscription = { ownerUserId: "o1", planId: "standard", addOns: ["video_360"], status: "active", endsAt: "2027-01-01T00:00:00.000Z", priceSnapshotCents: 100 };

describe("plans", () => {
  it("gates video and 360 by plan or add-on, and only while active", () => {
    expect(canUploadKind(basic, undefined, "photo", now)).toBe(true);
    expect(canUploadKind(basic, undefined, "video", now)).toBe(false);
    expect(canUploadKind(standard, sub, "video", now)).toBe(true);
    expect(hasFeature(standard, sub, "video_360", now)).toBe(true);
    expect(hasFeature(standard, { ...sub, status: "expired" }, "video", now)).toBe(false);
    expect(hasFeature(standard, { ...sub, endsAt: "2026-01-01T00:00:00.000Z" }, "video", now)).toBe(false);
  });
  it("cannot be bought until an admin sets prices", () => {
    expect(quote(standard, ["video_360"], {}).ok).toBe(false);
    expect(quote({ ...standard, priceCents: 1000 }, ["video_360"], { video_360: 500 })).toEqual({ ok: true, totalCents: 1500 });
  });
  it("enforces the photo limit", () => {
    expect(withinPhotoLimit(basic, 14)).toBe(true);
    expect(withinPhotoLimit(basic, 15)).toBe(false);
  });
});

const report: DocumentRecord = { id: "r1", listingId: "l1", ownerUserId: "o1", kind: "pest_report", uploadedBy: "o1", visibility: "public", status: "active" };

describe("checkDescription", () => {
  it("accepts a cited description that discloses the reports", () => {
    const d = { text: `Renovated kitchen. ${REPORTS_NOTICE}`, claims: [{ text: "Renovated kitchen", sourceDocId: "r1" }] };
    expect(checkDescription(d, [report], [{ docId: "r1", adverseFindings: false }]).ok).toBe(true);
  });
  it("blocks absolute claims, unknown sources and missing disclosures", () => {
    const d = { text: "A termite-free, defect-free home.", claims: [{ text: "x", sourceDocId: "nope" }] };
    const r = checkDescription(d, [report], []);
    expect(r.ok).toBe(false);
    expect(r.problems.length).toBeGreaterThanOrEqual(3);
  });
  it("requires disclosure of adverse findings", () => {
    const d = { text: `Great home. ${REPORTS_NOTICE}`, claims: [{ text: "Great", sourceDocId: "r1" }] };
    expect(checkDescription(d, [report], [{ docId: "r1", adverseFindings: true }]).ok).toBe(false);
    expect(checkDescription({ ...d, text: `${d.text} ${ADVERSE_NOTICE}` }, [report], [{ docId: "r1", adverseFindings: true }]).ok).toBe(true);
  });
});
