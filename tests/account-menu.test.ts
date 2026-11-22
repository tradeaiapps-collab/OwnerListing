import { describe, expect, it } from "vitest";
import { ACCOUNT_MENU, activeAccountItem } from "../src/domain/account-menu";
import { parseDisplayName } from "../src/domain/profile";

describe("account menu", () => {
  it("has the four groups with unique ids and hrefs", () => {
    expect(ACCOUNT_MENU.map(g => g.title)).toEqual(["Profile and security", "My property", "Money", "Help"]);
    const items = ACCOUNT_MENU.flatMap(g => g.items);
    expect(new Set(items.map(i => i.id)).size).toBe(items.length);
    expect(new Set(items.map(i => i.href)).size).toBe(items.length);
  });
  it("marks the longest matching item active", () => {
    expect(activeAccountItem("/settings")?.id).toBe("profile");
    expect(activeAccountItem("/settings/roles")?.id).toBe("roles");
    expect(activeAccountItem("/settings/language")?.id).toBe("language");
    expect(activeAccountItem("/settings/delete")?.id).toBe("profile");
  });
});

describe("display name", () => {
  it("trims and collapses spaces", () => expect(parseDisplayName({ displayName: "  Ann   Lee " })).toEqual({ ok: true, value: "Ann Lee" }));
  it("rejects empty, long and markup names", () => {
    expect(parseDisplayName({ displayName: "A" }).ok).toBe(false);
    expect(parseDisplayName({ displayName: "x".repeat(81) }).ok).toBe(false);
    expect(parseDisplayName({ displayName: "<b>x</b>" }).ok).toBe(false);
    expect(parseDisplayName(null).ok).toBe(false);
  });
});
