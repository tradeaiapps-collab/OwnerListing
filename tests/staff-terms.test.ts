import { describe, expect, it } from "vitest";
import { evaluateOverride, staffCan, staffCanGenerate } from "../src/domain/staff-access";
import { aiLearningCovered, hasAcceptedCurrentTerms } from "../src/domain/terms";

const admin = { id: "a1", role: "super_admin" as const };
const admin2 = { id: "a2", role: "super_admin" as const };
const support = { id: "s1", role: "support" as const };
const reason = "Owner asked us to correct the listing address.";

describe("staff access", () => {
  it("limits each team to its own reports and data", () => {
    expect(staffCanGenerate({ id: "x", role: "accountant" }, "financial_internal")).toBe(true);
    expect(staffCanGenerate({ id: "x", role: "support" }, "financial_internal")).toBe(false);
    expect(staffCan({ id: "x", role: "technical" }, "pii.view_full")).toBe(false);
  });
  it("lets a super admin override directly but needs a second person for safety gates", () => {
    expect(evaluateOverride(admin, { target: "listing", reason }).allowed).toBe(true);
    expect(evaluateOverride(admin, { target: "trust_account", reason }).allowed).toBe(false);
    expect(evaluateOverride(admin, { target: "trust_account", reason }, admin2).allowed).toBe(true);
    expect(evaluateOverride(admin, { target: "trust_account", reason }, admin).allowed).toBe(false);
  });
  it("never rewrites permanent records and requires a reason", () => {
    expect(evaluateOverride(admin, { target: "audit_event", reason }).allowed).toBe(false);
    expect(evaluateOverride(admin, { target: "listing", reason: "no" }).allowed).toBe(false);
  });
  it("needs approval for non-super-admin requests", () => {
    expect(evaluateOverride(support, { target: "listing", reason }).allowed).toBe(false);
    expect(evaluateOverride(support, { target: "listing", reason }, admin).allowed).toBe(true);
  });
});

describe("terms", () => {
  const cur = { version: "2", includesAiLearningClause: true };
  it("requires acceptance of the current version", () => {
    expect(hasAcceptedCurrentTerms([{ userId: "u", version: "1" }], "u", cur)).toBe(false);
    expect(aiLearningCovered([{ userId: "u", version: "2" }], "u", cur)).toBe(true);
    expect(aiLearningCovered([{ userId: "u", version: "2" }], "u", { ...cur, includesAiLearningClause: false })).toBe(false);
  });
});
