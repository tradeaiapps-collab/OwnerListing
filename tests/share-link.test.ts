import { describe, expect, it } from "vitest";
import { listingShareUrl } from "../src/domain/share-link";

describe("listingShareUrl", () => {
  it("joins the site origin and listing id", () => {
    expect(listingShareUrl("https://app.confsec.com.au", "abc-1")).toBe("https://app.confsec.com.au/listings/abc-1");
  });
  it("ignores a trailing slash and escapes the id", () => {
    expect(listingShareUrl("https://x.test/", "a b")).toBe("https://x.test/listings/a%20b");
  });
});
