import { describe, expect, it } from "vitest";
import { ESIGN_CONSENT_VERSION, MAX_SIGNERS, evidenceHash, expiryFrom, ipHash, parseSignature, parseSigners, requestStatusAfter } from "../src/domain/e-sign";

const U1 = "11111111-1111-4111-8111-111111111111", U2 = "22222222-2222-4222-8222-222222222222";

describe("e-sign", () => {
  const base = { contentSha256: "a".repeat(64), requestId: "r", userId: "u", typedName: "Ada Lovelace", signedAtIso: "2026-11-05T00:00:00.000Z", consentVersion: ESIGN_CONSENT_VERSION };
  it("makes a stable evidence hash that changes with any fact", () => {
    expect(evidenceHash(base)).toBe(evidenceHash({ ...base }));
    expect(evidenceHash(base)).toMatch(/^[0-9a-f]{64}$/);
    for (const k of Object.keys(base) as (keyof typeof base)[]) expect(evidenceHash({ ...base, [k]: `${base[k]}x` }), k).not.toBe(evidenceHash(base));
  });
  it("hashes the address with a key and never returns it", () => {
    expect(ipHash("1.2.3.4", "s")).not.toContain("1.2.3.4");
    expect(ipHash("1.2.3.4", "s")).not.toBe(ipHash("1.2.3.4", "t"));
  });
  it("needs consent, the current wording and a full name", () => {
    const body = { consent: true, consentVersion: ESIGN_CONSENT_VERSION, typedName: "  Ada Lovelace " };
    expect(parseSignature(body)).toEqual({ ok: true, typedName: "Ada Lovelace" });
    expect(parseSignature({ ...body, consent: false }).ok).toBe(false);
    expect(parseSignature({ ...body, consentVersion: "old" }).ok).toBe(false);
    for (const n of ["Ada", "12 34", "<b> x y", ""]) expect(parseSignature({ ...body, typedName: n }).ok, n).toBe(false);
  });
  it("checks the signer list", () => {
    expect(parseSigners([{ userId: U1, roleLabel: "Owner" }, { userId: U2, roleLabel: "Buyer" }]).ok).toBe(true);
    expect(parseSigners([]).ok).toBe(false);
    expect(parseSigners([{ userId: U1, roleLabel: "Owner" }, { userId: U1.toUpperCase(), roleLabel: "Buyer" }]).ok).toBe(false);
    expect(parseSigners([{ userId: "x", roleLabel: "Owner" }]).ok).toBe(false);
    expect(parseSigners(Array.from({ length: MAX_SIGNERS + 1 }, (_, i) => ({ userId: `${i}`.padStart(8, "0") + U1.slice(8), roleLabel: "R" }))).ok).toBe(false);
  });
  it("completes only when all signed, and one decline closes it", () => {
    expect(requestStatusAfter(["signed", "signed"])).toBe("completed");
    expect(requestStatusAfter(["signed", "pending"])).toBe("pending");
    expect(requestStatusAfter(["signed", "declined"])).toBe("declined");
    expect(requestStatusAfter([])).toBe("pending");
  });
  it("expires after 14 days", () => expect(expiryFrom("2026-11-05T00:00:00.000Z")).toBe("2026-11-19T00:00:00.000Z"));
});
