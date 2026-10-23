import { describe, expect, it } from "vitest";
import { BOND_PATHWAY_LABELS } from "../app/listings/ui";
import { BOND_PATHWAYS } from "../src/domain/listing-service";

describe("bond pathway owner labels", () => {
  it("has exactly one non-empty label per bond pathway the API accepts", () => {
    expect(Object.keys(BOND_PATHWAY_LABELS).sort()).toEqual([...BOND_PATHWAYS].sort());
    for (const label of Object.values(BOND_PATHWAY_LABELS)) expect(label.trim()).not.toBe("");
  });
});
