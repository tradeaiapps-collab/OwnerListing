import { describe, expect, it } from "vitest";
import { termsGateFor } from "../src/domain/terms";
import { requireCurrentTerms } from "../src/server/terms-guard";

describe("requireCurrentTerms", () => {
  it("passes only on an explicit true", async () => {
    expect(await requireCurrentTerms(async () => true, "u1")).toBeNull();
  });
  it("denies with forbidden on false, a missing check, a throwing check and odd values", async () => {
    expect(await requireCurrentTerms(async () => false, "u1")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await requireCurrentTerms(undefined, "u1")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await requireCurrentTerms(async () => { throw new Error("db down"); }, "u1")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await requireCurrentTerms((async () => "yes") as unknown as () => Promise<boolean>, "u1")).toMatchObject({ code: "forbidden" });
  });
  it("termsGateFor only passes true", () => {
    expect(termsGateFor(true)).toBeNull();
    for (const v of [false, undefined, null, 1, "true"]) expect(termsGateFor(v)).not.toBeNull();
  });
});
