import { describe, expect, it } from "vitest";
import { forbiddenFor } from "../src/domain/access";

describe("forbiddenFor (route guards)", () => {
  it("lets owners create and publish listings", () => {
    expect(forbiddenFor({ id: "o", role: "owner" }, "listing.create")).toBeNull();
    expect(forbiddenFor({ id: "o", role: "owner" }, "listing.publish")).toBeNull();
  });

  it("stops agents from creating listings but allows publish attempts (the service still requires ownership)", () => {
    expect(forbiddenFor({ id: "a", role: "agent" }, "listing.create")).toEqual({ ok: false, code: "forbidden", message: "Your account cannot do this." });
    expect(forbiddenFor({ id: "a", role: "agent" }, "listing.publish")).toBeNull();
  });

  it("stops other roles from creating or publishing", () => {
    expect(forbiddenFor({ id: "v", role: "vendor" }, "listing.create")?.code).toBe("forbidden");
    expect(forbiddenFor({ id: "v", role: "vendor" }, "listing.publish")?.code).toBe("forbidden");
  });
});
