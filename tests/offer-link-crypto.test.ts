import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LINK_TTL_MINUTES } from "../src/domain/offer-intake";
import { OfferLinkKeyError, openOfferToken, sealOfferToken } from "../src/domain/offer-link-crypto";

const KEY = Buffer.alloc(32, 7).toString("base64");
const OTHER = Buffer.alloc(32, 9).toString("base64");

describe("offer link token sealing (AES-256-GCM)", () => {
  it("round trips and never contains the plaintext", async () => {
    const s = await sealOfferToken("secret-token-123", KEY, "req-1");
    expect(s.startsWith("v1.")).toBe(true);
    expect(s).not.toContain("secret-token-123");
    expect(await openOfferToken(s, KEY, "req-1")).toBe("secret-token-123");
  });
  it("uses a random IV per record", async () => {
    const a = await sealOfferToken("t", KEY, "r");
    const b = await sealOfferToken("t", KEY, "r");
    expect(a).not.toBe(b);
  });
  it("detects tampering, a different row, and a wrong key", async () => {
    const s = await sealOfferToken("secret", KEY, "req-1");
    const raw = Buffer.from(s.slice(3), "base64");
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 1;
    expect(await openOfferToken("v1." + raw.toString("base64"), KEY, "req-1")).toBeUndefined();
    expect(await openOfferToken(s, KEY, "req-2")).toBeUndefined();
    expect(await openOfferToken(s, OTHER, "req-1")).toBeUndefined();
    expect(await openOfferToken("garbage", KEY, "req-1")).toBeUndefined();
    expect(await openOfferToken("v1.AAAA", KEY, "req-1")).toBeUndefined();
  });
  it("fails closed when the key is missing or malformed", async () => {
    for (const k of [undefined, "", "   ", "short", Buffer.alloc(16).toString("base64"), Buffer.alloc(33).toString("base64")]) {
      await expect(sealOfferToken("t", k, "r")).rejects.toBeInstanceOf(OfferLinkKeyError);
      await expect(openOfferToken("v1.AAAA", k, "r")).rejects.toBeInstanceOf(OfferLinkKeyError);
    }
  });
  it("keeps the link life at 24 hours or less", () => {
    expect(LINK_TTL_MINUTES).toBeLessThanOrEqual(24 * 60);
  });
  it("migration stores ciphertext, not the raw token", () => {
    const sql = readFileSync(new URL("../db/20261024150000_offer_link_request.sql", import.meta.url), "utf8");
    expect(sql).toMatch(/link_ciphertext TEXT,/);
    expect(sql).not.toMatch(/delivered_token/);
  });
});
