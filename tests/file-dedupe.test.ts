import { describe, expect, it } from "vitest";
import { skippedNote, splitDuplicates } from "../src/domain/file-dedupe";

const f = (name: string, size: number, digest: string) => ({ name, size, digest });

describe("file duplicates", () => {
  it("skips a file already held, even when renamed", () => {
    const r = splitDuplicates([f("a.jpg", 10, "x")], [f("copy.jpg", 10, "x"), f("b.jpg", 20, "y")]);
    expect(r.skipped.map(s => s.name)).toEqual(["copy.jpg"]);
    expect(r.fresh.map(s => s.name)).toEqual(["b.jpg"]);
  });
  it("skips repeats inside one batch and keeps the first", () => {
    const r = splitDuplicates([], [f("a.jpg", 1, "x"), f("a.jpg", 1, "x"), f("a.jpg", 1, "x")]);
    expect(r.fresh).toHaveLength(1); expect(r.skipped).toHaveLength(2);
  });
  it("treats same hash but different size as different", () => expect(splitDuplicates([f("a", 1, "x")], [f("b", 2, "x")]).fresh).toHaveLength(1));
  it("skips a repeated name, ignoring case, even with different content", () => {
    const r = splitDuplicates([f("Front.JPG", 10, "x")], [f("front.jpg", 99, "z")]);
    expect(r.skipped).toHaveLength(1); expect(r.fresh).toHaveLength(0);
  });
  it("writes a short note", () => {
    expect(skippedNote([])).toBe("");
    expect(skippedNote([{ name: "a.jpg" }])).toBe("Skipped a.jpg: already added.");
    expect(skippedNote([{ name: "a" }, { name: "b" }])).toBe("Skipped 2 files: already added.");
  });
});
