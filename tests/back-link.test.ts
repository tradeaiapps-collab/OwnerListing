import { describe, expect, it } from "vitest";
import { pickReturnPath } from "../app/back-link";

const O = "http://localhost:3005";
describe("pickReturnPath", () => {
  it("uses a safe ?from=", () => expect(pickReturnPath("?from=/listings?page=2", "", O, "/terms")).toBe("/listings?page=2"));
  it("rejects off-site from", () => expect(pickReturnPath("?from=//evil.com", "", O, "/terms")).toBeUndefined());
  it("falls back to a same-site referrer", () => expect(pickReturnPath("", `${O}/signup`, O, "/terms")).toBe("/signup"));
  it("ignores other-site and self referrers", () => {
    expect(pickReturnPath("", "https://evil.com/x", O, "/terms")).toBeUndefined();
    expect(pickReturnPath("", `${O}/terms`, O, "/terms")).toBeUndefined();
  });
});
