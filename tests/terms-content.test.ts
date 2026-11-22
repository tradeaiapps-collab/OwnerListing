import { describe, expect, it } from "vitest";
import { TERMS_PARTS, TERMS_SUMMARY } from "../src/domain/terms-content";

describe("terms content", () => {
  const sections = TERMS_PARTS.flatMap(p => p.sections);
  it("has unique ids and non-empty text", () => {
    const ids = [...TERMS_PARTS.map(p => p.id), ...sections.map(s => s.id)];
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of sections) expect(s.paragraphs.length).toBeGreaterThan(0);
  });
  it("covers the required topics", () => {
    const text = JSON.stringify(TERMS_PARTS).toLowerCase();
    for (const k of ["trust account", "permanent records", "cookie", "privacy principles", "governing law", "limitation of liability", "australian consumer law", "termination"]) {
      expect(text.includes(k) || text.includes(k.replace("termination", "terminate"))).toBe(true);
    }
  });
  it("keeps the summary promises", () => {
    const t = TERMS_SUMMARY.join(" ");
    expect(t).toMatch(/holds no money/);
    expect(t).toMatch(/never accepts an offer/);
    expect(t).toMatch(/cannot be deleted/);
  });
  it("section cross-references point to real sections", () => {
    const nums = new Set(sections.map(s => s.title.split(" ")[0]));
    const text = sections.flatMap(s => s.paragraphs).join(" ");
    for (const m of text.matchAll(/\((\d\.\d)\)|under (\d\.\d)|in (\d\.\d)/g)) expect(nums.has(m[1] ?? m[2] ?? m[3]!)).toBe(true);
  });
});
