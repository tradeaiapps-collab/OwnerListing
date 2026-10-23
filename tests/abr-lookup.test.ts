import { describe, expect, it } from "vitest";
import { createAbrLookup } from "../src/adapters/abr-lookup";
import { abnRecheckDue } from "../src/domain/abn";

const reply = (body: string, ok = true) => async () => ({ ok, text: async () => body });

describe("ABR lookup", () => {
  it("reads an active business", async () => {
    const p = createAbrLookup("key", reply('cb({"Abn":"51824753556","AbnStatus":"Active","EntityName":"EXAMPLE PTY LTD","Message":""})'));
    expect(await p.lookup("51 824 753 556")).toEqual({ abn: "51824753556", active: true, entityName: "EXAMPLE PTY LTD" });
  });
  it("reads a cancelled business as not active", async () => {
    const p = createAbrLookup("key", reply('cb({"Abn":"51824753556","AbnStatus":"Cancelled","EntityName":"X","Message":""})'));
    expect((await p.lookup("51824753556"))?.active).toBe(false);
  });
  it("returns null when not found, and throws when the register is down", async () => {
    expect(await createAbrLookup("key", reply('cb({"Message":"No records found"})')).lookup("51824753556")).toBeNull();
    await expect(createAbrLookup("key", reply("", false)).lookup("51824753556")).rejects.toThrow();
    expect(() => createAbrLookup(" ")).toThrow();
  });
  it("re-checks every 30 days", () => {
    const now = new Date("2026-10-23T00:00:00Z");
    expect(abnRecheckDue(null, now)).toBe(true);
    expect(abnRecheckDue(new Date("2026-10-01T00:00:00Z"), now)).toBe(false);
    expect(abnRecheckDue(new Date("2026-09-20T00:00:00Z"), now)).toBe(true);
  });
});
