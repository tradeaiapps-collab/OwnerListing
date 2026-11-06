import { describe, expect, it } from "vitest";
import { canGoBack, currentScroll, emptyNav, isBackLabel, parseNav, previousEntry, setScroll, visit } from "../src/domain/nav-history";

describe("navigation memory", () => {
  it("goes back to the exact page and scroll position left", () => {
    let s = emptyNav("/staff");
    s = setScroll(s, 640);
    s = visit(s, "/staff/investments", "push");
    s = setScroll(s, 120);
    s = visit(s, "/staff/investments/settings", "push");
    expect(previousEntry(s)?.url).toBe("/staff/investments");
    s = visit(s, "/staff/investments", "pop");
    expect(currentScroll(s)).toBe(120);
    s = visit(s, "/staff", "pop");
    expect(currentScroll(s)).toBe(640);
    expect(canGoBack(s)).toBe(false);
  });
  it("drops forward entries on a new push and ignores duplicate pushes", () => {
    let s = visit(visit(emptyNav("/a"), "/b", "push"), "/c", "push");
    s = visit(s, "/b", "pop");
    s = visit(s, "/d", "push");
    expect(s.stack.map(e => e.url)).toEqual(["/a", "/b", "/d"]);
    expect(visit(s, "/d", "push")).toBe(s);
  });
  it("replace swaps the current entry; multi-step pops find the nearest match", () => {
    let s = visit(visit(visit(emptyNav("/a"), "/b", "push"), "/c", "push"), "/d", "push");
    s = visit(s, "/a", "pop");
    expect(s.index).toBe(0);
    expect(visit(s, "/a?x=1", "replace").stack[0].url).toBe("/a?x=1");
  });
  it("caps the stack", () => {
    let s = emptyNav("/0");
    for (let i = 1; i < 150; i++) s = visit(s, `/${i}`, "push");
    expect(s.stack.length).toBe(100);
    expect(s.stack[s.index]!.url).toBe("/149");
  });
  it("rejects stored state for another page", () => {
    const raw = JSON.stringify(visit(emptyNav("/a"), "/b", "push"));
    expect(parseNav(raw, "/b").index).toBe(1);
    expect(parseNav(raw, "/zzz").index).toBe(0);
    expect(parseNav("garbage", "/a").stack).toHaveLength(1);
  });
  it("recognises back links", () => {
    expect(isBackLabel("Back to investor projects")).toBe(true);
    expect(isBackLabel("← Back")).toBe(true);
    expect(isBackLabel("Backup settings")).toBe(false);
  });
});
