import { describe, expect, it } from "vitest";
import { resolveAdvisoryMode, withPublicDisclaimer, PUBLIC_AI_DISCLAIMER } from "../src/domain/ai-advisory";

const cred = { userId: "b1", creditLicenceVerified: true };
const nom = { brokerUserId: "b1", buyerUserId: "u1", active: true, buyerConsentToShareFinancials: true };

describe("resolveAdvisoryMode", () => {
  it("gives the professional AI only to a verified, nominated broker with buyer consent", () => {
    expect(resolveAdvisoryMode("b1", "u1", cred, nom)).toBe("broker_professional");
    expect(resolveAdvisoryMode("b1", "u1", { ...cred, creditLicenceVerified: false }, nom)).toBe("public_general");
    expect(resolveAdvisoryMode("b1", "u1", cred, { ...nom, buyerConsentToShareFinancials: false })).toBe("public_general");
    expect(resolveAdvisoryMode("b1", "u1", cred, { ...nom, active: false })).toBe("public_general");
    expect(resolveAdvisoryMode("b1", "u2", cred, nom)).toBe("public_general");
    expect(resolveAdvisoryMode("b1", "u1")).toBe("public_general");
  });
  it("adds the disclaimer to public output", () => {
    expect(withPublicDisclaimer("hi")).toContain(PUBLIC_AI_DISCLAIMER);
  });
});
