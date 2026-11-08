import { describe, expect, it } from "vitest";
import { roleNav } from "../src/domain/role-nav";
import { USER_ROLES } from "../src/domain/roles";

const labels = (r: (typeof USER_ROLES)[number]) => roleNav(r).map(i => i.label);

describe("role navigation", () => {
  it("shows the focused items for each role", () => {
    expect(labels("owner")).toEqual(["My listings", "Offers", "Projects", "Messages", "Agent performance", "Account"]);
    expect(labels("buyer")).toEqual(["Browse", "Search", "My offers", "Saved searches", "Projects", "Messages", "Account"]);
    expect(labels("agent")).toEqual(["Listings", "CRM", "Projects", "Messages", "Reports", "Workspace", "Account"]);
    expect(labels("investor")).toEqual(["Projects", "Portfolio", "Insights", "Messages", "Account"]);
  });
  it("keeps Account on every role with unique ids", () => {
    for (const r of USER_ROLES) {
      expect(labels(r)).toContain("Account");
      const ids = roleNav(r).map(i => i.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
