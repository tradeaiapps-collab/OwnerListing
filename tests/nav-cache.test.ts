import { describe, expect, it } from "vitest";
import { parseNavSnapshot, serializeNavSnapshot } from "../src/domain/nav-cache";

describe("nav cache", () => {
  it("round-trips a snapshot", () => {
    expect(parseNavSnapshot(serializeNavSnapshot({ who: "owner", role: "agent" }))).toEqual({ who: "owner", role: "agent" });
  });
  it("rejects missing, malformed or unknown values", () => {
    expect(parseNavSnapshot(null)).toBeNull();
    expect(parseNavSnapshot("{")).toBeNull();
    expect(parseNavSnapshot('{"who":"admin"}')).toBeNull();
    expect(parseNavSnapshot('{"who":"buyer","role":5}')).toEqual({ who: "buyer", role: null });
  });
});
