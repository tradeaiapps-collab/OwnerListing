import { describe, expect, it } from "vitest";
import { amendDocument, canUploadDocument, canViewDocument, evaluateDeletionRequest, validateUpload, type DocumentRecord } from "../src/domain/documents";
import type { JobAssignment } from "../src/domain/job-chat";

const sha = "a".repeat(64);
const photographer: JobAssignment = { id: "a1", listingId: "l1", ownerUserId: "o1", contractorUserId: "p1", kind: "photographer", status: "approved" };
const doc: DocumentRecord = { id: "d1", listingId: "l1", ownerUserId: "o1", kind: "contract", uploadedBy: "o1", visibility: "parties", status: "active" };

describe("documents", () => {
  it("validates type, size and fingerprint", () => {
    expect(validateUpload({ kind: "photo", declaredMime: "image/jpeg", sizeBytes: 1000, sha256: sha })).toEqual([]);
    expect(validateUpload({ kind: "photo", declaredMime: "application/x-msdownload", sizeBytes: 1000, sha256: sha })).not.toEqual([]);
    expect(validateUpload({ kind: "photo", declaredMime: "image/png", sizeBytes: 26_000_000, sha256: sha })).not.toEqual([]);
    expect(validateUpload({ kind: "pest_report", declaredMime: "application/pdf", sizeBytes: 10, sha256: "x" })).not.toEqual([]);
  });
  it("limits contractors to their own kinds, only when approved", () => {
    expect(canUploadDocument("p1", "o1", "l1", "photo", [photographer])).toBe(true);
    expect(canUploadDocument("p1", "o1", "l1", "contract", [photographer])).toBe(false);
    expect(canUploadDocument("p1", "o1", "l1", "photo", [{ ...photographer, status: "proposed" }])).toBe(false);
    expect(canUploadDocument("x", "o1", "l1", "photo", [photographer])).toBe(false);
  });
  it("controls who can view", () => {
    expect(canViewDocument("o1", doc, false, [])).toBe(true);
    expect(canViewDocument("p1", doc, true, [photographer])).toBe(true);
    expect(canViewDocument(undefined, doc, true, [])).toBe(false);
    expect(canViewDocument(undefined, { ...doc, visibility: "public" }, false, [])).toBe(false);
    expect(canViewDocument(undefined, { ...doc, visibility: "public" }, true, [])).toBe(true);
  });
  it("lets the owner delete before publishing, then amend only", () => {
    const photo = { ...doc, kind: "photo" as const };
    expect(evaluateDeletionRequest("x", photo, { everPublished: false, saleCompleted: false }).kind).toBe("rejected");
    expect(evaluateDeletionRequest("o1", photo, { everPublished: false, saleCompleted: false }).kind).toBe("delete_now");
    expect(evaluateDeletionRequest("o1", photo, { everPublished: true, saleCompleted: false }).kind).toBe("amend_only");
    expect(evaluateDeletionRequest("o1", doc, { everPublished: true, saleCompleted: true }).kind).toBe("held");
  });
  it("keeps the earlier version when a file is amended", () => {
    const r = amendDocument({ ...doc, kind: "photo" }, "d2", "o1");
    expect(r.previous.status).toBe("superseded");
    expect(r.next.supersedesId).toBe("d1");
    expect(() => amendDocument(r.previous, "d3", "o1")).toThrow(/active/);
  });
  it("accepts video and 360 files within limits", () => {
    expect(validateUpload({ kind: "video_360", declaredMime: "video/mp4", sizeBytes: 3_000_000_000, sha256: sha })).toEqual([]);
    expect(validateUpload({ kind: "video", declaredMime: "video/mp4", sizeBytes: 3_000_000_000, sha256: sha })).not.toEqual([]);
    expect(validateUpload({ kind: "photo_360", declaredMime: "image/jpeg", sizeBytes: 50_000_000, sha256: sha })).toEqual([]);
  });
});
