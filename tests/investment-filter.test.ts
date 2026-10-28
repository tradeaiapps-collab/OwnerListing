import { describe, expect, it } from "vitest";
import { filterProjects } from "../src/domain/investor-projects";

const base = { title: "Riverside townhouses", location: "Toowong", jurisdiction: "QLD", projectType: "residential_development", summary: "Six townhouses near the river.", stage: "approved", minimumTicketCents: 5_000_000, issuerName: "Acme Capital" } as const;
const items = [
  base,
  { ...base, title: "Office refit", summary: "Fit-out of a three-storey office.", location: "Parramatta", jurisdiction: "NSW", projectType: "renovation", stage: "construction", minimumTicketCents: 50_000_000, issuerName: "Beta Funds" }
];

describe("filterProjects", () => {
  it("returns everything with no filter", () => expect(filterProjects(items, {})).toHaveLength(2));
  it("matches every search word, case-insensitive, across title, location, summary and issuer", () => {
    expect(filterProjects(items, { q: "TOWNHOUSES acme" }).map(p => p.title)).toEqual(["Riverside townhouses"]);
    expect(filterProjects(items, { q: "parramatta" }).map(p => p.title)).toEqual(["Office refit"]);
    expect(filterProjects(items, { q: "townhouses beta" })).toEqual([]);
    expect(filterProjects(items, { q: "   " })).toHaveLength(2);
  });
  it("filters by state, type and stage", () => {
    expect(filterProjects(items, { jurisdiction: "NSW" }).map(p => p.title)).toEqual(["Office refit"]);
    expect(filterProjects(items, { projectType: "residential_development", stage: "approved" })).toHaveLength(1);
    expect(filterProjects(items, { stage: "concept" })).toEqual([]);
  });
  it("keeps projects whose minimum is at or under the cap", () => {
    expect(filterProjects(items, { maxMinimumCents: 5_000_000 }).map(p => p.title)).toEqual(["Riverside townhouses"]);
    expect(filterProjects(items, { maxMinimumCents: 0 })).toEqual([]);
  });
});
