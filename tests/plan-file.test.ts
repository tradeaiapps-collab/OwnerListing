import { describe, expect, it } from "vitest";
import { PLAN_PDF_MAX_BYTES, planProblem } from "../src/domain/plan-file";
import { validateUpload } from "../src/domain/documents";

const pdf = new TextEncoder().encode("%PDF-1.7\n%....");
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const f = (type: string, size = 1000, name = "plan.pdf") => ({ name, type, size });

describe("planProblem", () => {
  it("accepts a real PDF and a real image", () => {
    expect(planProblem(f("application/pdf"), pdf)).toBeNull();
    expect(planProblem(f("image/png", 1000, "p.png"), png)).toBeNull();
  });
  it("refuses a file whose bytes are not what its type says", () => {
    expect(planProblem(f("application/pdf"), png)).toMatch(/do not match/);
    expect(planProblem(f("image/png", 1000, "p.png"), pdf)).toMatch(/do not match/);
    expect(planProblem(f("application/pdf"), new TextEncoder().encode("<script>alert(1)</script>"))).toMatch(/do not match/);
  });
  it("refuses other types, empty files and oversize PDFs", () => {
    expect(planProblem(f("text/html", 10, "x.html"), pdf)).toMatch(/JPEG, PNG, WebP or PDF/);
    expect(planProblem(f("application/pdf", 0), pdf)).toMatch(/empty/);
    expect(planProblem(f("application/pdf", PLAN_PDF_MAX_BYTES + 1), pdf)).toMatch(/larger than 20 MB/);
  });
});

describe("server floor plan rules", () => {
  const sha = "a".repeat(64);
  it("allows a PDF floor plan up to 20 MB and refuses more", () => {
    expect(validateUpload({ kind: "floorplan", declaredMime: "application/pdf", sizeBytes: PLAN_PDF_MAX_BYTES, sha256: sha })).toEqual([]);
    expect(validateUpload({ kind: "floorplan", declaredMime: "application/pdf", sizeBytes: PLAN_PDF_MAX_BYTES + 1, sha256: sha })).toEqual(["File is too large."]);
  });
  it("still refuses a PDF as a gallery photo", () => {
    expect(validateUpload({ kind: "photo", declaredMime: "application/pdf", sizeBytes: 1000, sha256: sha })).not.toEqual([]);
  });
});
