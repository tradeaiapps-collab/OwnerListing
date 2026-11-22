import { describe, expect, it } from "vitest";
import { vetGoogleName } from "../src/server/auth/google";

const who = (name: string, email = "jane.citizen@example.com") => ({ sub: "s1", email, name });

describe("Google display name check", () => {
  it("keeps an ordinary name", () => {
    expect(vetGoogleName(who("Jane Citizen"))).toEqual({ identity: who("Jane Citizen"), replaced: false });
  });
  it("replaces a name with contact details by the start of the email address", () => {
    const r = vetGoogleName(who("Call me on 0412 345 678"));
    expect(r.replaced).toBe(true);
    expect(r.identity).toMatchObject({ name: "jane citizen", email: "jane.citizen@example.com", sub: "s1" });
  });
  it("replaces an abusive name, and falls back to Member when the email start is no better", () => {
    expect(vetGoogleName(who("Call me on 0412 345 678", "0412345678@example.com"))).toMatchObject({ replaced: true, identity: { name: "Member" } });
    expect(vetGoogleName(who("Call me on 0412 345 678", "x@example.com")).replaced).toBe(true);
  });
});
