import { describe, expect, it } from "vitest";
import { buildOfferUrl, dollarsToCents, parseConditionLines, readOfferToken } from "../src/domain/offer-form";

describe("offer form helpers", () => {
  it("converts dollars to cents and rejects bad amounts", () => {
    expect(dollarsToCents("$1,250,000")).toBe(125000000);
    expect(dollarsToCents("10.5")).toBe(1050);
    expect(dollarsToCents("0")).toBe(0);
    for (const bad of ["", "abc", "-5", "1.234", "1e6", "99999999999999999999"]) expect(dollarsToCents(bad)).toBeUndefined();
  });
  it("splits conditions by line", () => {
    expect(parseConditionLines(" Finance \n\n Building report\r\n")).toEqual(["Finance", "Building report"]);
  });
  it("reads the token from the fragment, then the query, else empty", () => {
    expect(readOfferToken("#token=abc_-1", "?token=zzz")).toBe("abc_-1");
    expect(readOfferToken("", "?listing=1&token=zzz")).toBe("zzz");
    expect(readOfferToken("", "")).toBe("");
  });
  it("builds a link with the token in the fragment only", () => {
    const u = buildOfferUrl("https://x.test", "L1", "tok-en_1");
    expect(u).toBe("https://x.test/offers/new?listing=L1#token=tok-en_1");
    expect(new URL(u).search).not.toContain("tok");
  });
});
