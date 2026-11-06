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
    expect(visit(s, "/a?x=1", "replace").stack[0]!.url).toBe("/a?x=1");
  });
  it("caps the stack", () => {
    let s = emptyNav("/0");
    for (let i = 1; i < 150; i++) s = visit(s, `/${i}`, "push");
    expect(s.stack.length).toBe(100);
    expect(s.stack[s.index]!.url).toBe("/149");
  });
  it("keeps the trail across full page loads (plain links)", () => {
    const raw = JSON.stringify(setScroll(visit(emptyNav("/listings"), "/listings", "replace"), 2756));
    const forward = parseNav(raw, "/listings/1", "navigate");
    expect(forward.stack.map(e => e.url)).toEqual(["/listings", "/listings/1"]);
    expect(forward.index).toBe(1);
    expect(forward.stack[0]!.y).toBe(2756);
    const back = parseNav(JSON.stringify(forward), "/listings", "back_forward");
    expect(back.index).toBe(0);
    expect(currentScroll(back)).toBe(2756);
  });
  it("keeps stored state on reload and starts fresh only on unreadable data", () => {
    const raw = JSON.stringify(visit(emptyNav("/a"), "/b", "push"));
    expect(parseNav(raw, "/b").index).toBe(1);
    expect(parseNav("garbage", "/a").stack).toHaveLength(1);
    expect(parseNav(null, "/a").stack).toHaveLength(1);
  });
  it("recognises back links", () => {
    expect(isBackLabel("Back to investor projects")).toBe(true);
    expect(isBackLabel("← Back")).toBe(true);
    expect(isBackLabel("Backup settings")).toBe(false);
  });
});
