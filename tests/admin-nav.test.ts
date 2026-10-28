import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ADMIN_GROUPS, activeHref, adminLink, groupSections } from "../src/domain/admin-nav";
import { sectionsFor, STAFF_SECTIONS } from "../src/domain/staff-admin";
import { SectionCards } from "../app/staff/section-cards";

describe("admin sidebar groups", () => {
  it("places every staff screen in a known group with an icon and a description", () => {
    const keys = new Set(ADMIN_GROUPS.map(g => g.key));
    for (const s of STAFF_SECTIONS) {
      const l = adminLink(s);
      expect(keys.has(l.group), s.href).toBe(true);
      expect(l.blurb.length, s.href).toBeGreaterThan(0);
    }
  });

  it("keeps each section once, in group order, and drops empty groups", () => {
    const groups = groupSections(STAFF_SECTIONS);
    expect(groups.flatMap(g => g.links.map(l => l.href)).sort()).toEqual(STAFF_SECTIONS.map(s => s.href).sort());
    expect(groups.map(g => g.key)).toEqual(ADMIN_GROUPS.map(g => g.key));
    const support = groupSections(sectionsFor({ id: "s", role: "support" }));
    expect(support.every(g => g.links.length > 0)).toBe(true);
    expect(support.flatMap(g => g.links.map(l => l.href))).not.toContain("/staff/pricing");
  });

  it("marks the longest matching section as active", () => {
    expect(activeHref("/staff/disclosures/reviews", STAFF_SECTIONS)).toBe("/staff/disclosures/reviews");
    expect(activeHref("/staff/disclosures", STAFF_SECTIONS)).toBe("/staff/disclosures");
    expect(activeHref("/staff/investments/settings/", STAFF_SECTIONS)).toBe("/staff/investments/settings");
    expect(activeHref("/staff/listings/abc?x=1", STAFF_SECTIONS)).toBe("/staff/listings");
    expect(activeHref("/staff", STAFF_SECTIONS)).toBeNull();
    expect(activeHref("/staff/listingsx", STAFF_SECTIONS)).toBeNull();
  });

  it("renders only the screens the role allows as cards", () => {
    const html = renderToStaticMarkup(createElement(SectionCards, { sections: sectionsFor({ id: "s", role: "support" }) }));
    expect(html).not.toContain("/staff/pricing");
    expect(html).toContain('class="section-card"');
  });
});
