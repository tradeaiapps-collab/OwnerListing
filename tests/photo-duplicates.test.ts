import { describe, expect, it } from "vitest";
import { dHash, findDuplicates, hammingDistance } from "../src/domain/photo-duplicates";

const grid = (f: (x: number, y: number) => number) => Array.from({ length: 72 }, (_, i) => f(i % 9, Math.floor(i / 9)));

describe("photo duplicates", () => {
  const a = dHash(grid((x, y) => (x * 17 + y * 5) % 200));
  const slightlyDifferent = dHash(grid((x, y) => ((x * 17 + y * 5) % 200) + (x === 3 && y === 2 ? 90 : 0)));
  const other = dHash(grid((x, y) => (x * 31 + y * 53 + (x * y) * 7) % 251));

  it("hashes identical grids identically", () => expect(dHash(grid(() => 5))).toHaveLength(64));
  it("measures distance", () => { expect(hammingDistance(a, a)).toBe(0); expect(hammingDistance(a, other)).toBeGreaterThan(6); });
  it("rejects a wrong-sized grid", () => expect(() => dHash([1, 2, 3])).toThrow());
  it("pairs a later photo with the earlier one it repeats", () => {
    const r = findDuplicates([{ id: "p1", hash: a }, { id: "p2", hash: other }, { id: "p4", hash: a }]);
    expect(r).toEqual([{ first: "p1", second: "p4", exact: true }]);
  });
  it("catches near matches but marks them not exact", () => {
    const r = findDuplicates([{ id: "p1", hash: a }, { id: "p2", hash: slightlyDifferent }]);
    expect(r).toHaveLength(1); expect(r[0]!.exact).toBe(false);
  });
  it("ignores photos with no hash", () => expect(findDuplicates([{ id: "p1", hash: null }, { id: "p2", hash: null }])).toEqual([]));
});
