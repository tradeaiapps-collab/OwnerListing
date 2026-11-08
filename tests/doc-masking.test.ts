import { describe, expect, it } from "vitest";
import { autoMaskBoxes, cleanTerms, findAddressRanges, uncoveredAuto, validateBoxes, type PageText } from "../src/domain/doc-masking";

const hits = (text: string, terms: string[] = []) => findAddressRanges(text, terms).map(r => text.slice(r.start, r.end));

describe("address detection", () => {
  it("finds street addresses, unit numbers and suburb/state/postcode", () => {
    expect(hits("The site is 12 Smith Street, Bulimba QLD 4171 and is level.")).toEqual(["12 Smith Street, Bulimba QLD 4171"]);
    expect(hits("Unit 4/45-47 Long Rd")).toEqual(["Unit 4/45-47 Long Rd"]);
    expect(hits("at 9 Old Mill Crescent.")[0]).toMatch(/^9 Old Mill Crescent/);
  });
  it("keeps a suburb between the street and the postcode inside one address", () => {
    expect(hits("Site address: 12 Smith Street, Pyrmont, Sydney NSW 2000 Issuer: X")).toEqual(["12 Smith Street, Pyrmont, Sydney NSW 2000"]);
  });
  it("finds lot and plan references and PO boxes", () => {
    expect(hits("Title: Lot 12 on SP 123456 held by the trust")[0]).toMatch(/^Lot 12 on SP 123456/);
    expect(hits("Lot 7 DP 12345")[0]).toBe("Lot 7 DP 12345");
    expect(hits("Write to PO Box 1234 please")).toEqual(["PO Box 1234"]);
  });
  it("leaves ordinary figures and words alone", () => {
    expect(hits("Total development cost 18 months, 6 townhouses, $2,500,000 funding target.")).toEqual([]);
    expect(hits("The act 2000 applies")).toEqual([]);
  });
  it("masks the admin's extra terms, whitespace-insensitive", () => {
    expect(hits("Called Harbour  View\nTowers in the plan", ["Harbour View Towers"])).toEqual(["Harbour  View\nTowers"]);
    expect(cleanTerms(["  ab ", "Harbour   View", "Harbour View"])).toEqual(["Harbour View"]);
  });
});

const run = (str: string, x: number, y = 0.1) => ({ str, x, y, w: str.length * 0.01, h: 0.012 });

describe("auto mask boxes", () => {
  it("boxes only the address part of a run and merges neighbours on one line", () => {
    const page: PageText = { runs: [run("Site at 12 Smith Street, Bulimba QLD 4171 for sale", 0.1)] };
    const [b, ...rest] = autoMaskBoxes([page]);
    expect(rest).toEqual([]);
    expect(b!.page).toBe(1);
    expect(b!.x).toBeGreaterThan(0.1 + 7 * 0.01 - 0.02);
    expect(b!.x).toBeLessThan(0.1 + 8 * 0.01);
    expect(b!.x + b!.w).toBeLessThan(0.1 + 50 * 0.01 - 0.05);
    expect(b!.source).toBe("auto");
  });
  it("covers an address split over two runs and two lines", () => {
    const page: PageText = { runs: [run("Located at 12 Smith", 0.1, 0.1), run("Street, Bulimba QLD 4171", 0.1, 0.12)] };
    const boxes = autoMaskBoxes([page]);
    expect(boxes.length).toBe(2);
    expect(boxes.every(b => b.page === 1)).toBe(true);
  });
  it("numbers pages from 1", () => {
    expect(autoMaskBoxes([{ runs: [] }, { runs: [run("PO Box 99", 0.2)] }])[0]!.page).toBe(2);
  });
});

describe("box validation and coverage", () => {
  const ok = { page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.05, source: "manual" };
  it("accepts good boxes and rejects bad ones", () => {
    expect(validateBoxes([ok], 1).ok).toBe(true);
    expect(validateBoxes([{ ...ok, page: 2 }], 1).ok).toBe(false);
    expect(validateBoxes([{ ...ok, x: 0.9, w: 0.5 }], 1).ok).toBe(false);
    expect(validateBoxes([{ ...ok, w: 0 }], 1).ok).toBe(false);
    expect(validateBoxes([{ ...ok, source: "x" }], 1).ok).toBe(false);
    expect(validateBoxes("no", 1).ok).toBe(false);
    expect(validateBoxes(Array.from({ length: 2001 }, () => ok), 1).ok).toBe(false);
  });
  it("reports auto boxes that no saved box covers", () => {
    const auto = [{ ...ok, source: "auto" as const }];
    expect(uncoveredAuto(auto, [])).toHaveLength(1);
    expect(uncoveredAuto(auto, [{ ...ok, x: 0.05, w: 0.4, h: 0.1 } as never])).toHaveLength(0);
    expect(uncoveredAuto(auto, [{ ...ok, page: 2 } as never])).toHaveLength(1);
  });
});
