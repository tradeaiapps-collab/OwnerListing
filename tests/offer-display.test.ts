import { describe, expect, it } from "vitest";
import { offerStatusLabel } from "../src/domain/offer-display";

describe("offer display wording", () => {
  it("tells each side whose move it is", () => {
    const ownerOpen = { fromParty: "owner" as const, status: "open" };
    expect(offerStatusLabel("countered", "owner", ownerOpen)).toBe("Your counter: waiting for the buyer");
    expect(offerStatusLabel("countered", "buyer", ownerOpen)).toBe("The owner countered");
    expect(offerStatusLabel("countered", "buyer")).toBe("The owner asked you to improve your offer");
    expect(offerStatusLabel("buyer_countered", "owner", { fromParty: "owner", status: "agreed" })).toBe("Buyer agreed to your terms");
    expect(offerStatusLabel("buyer_countered", "buyer", { fromParty: "buyer", status: "open" })).toBe("Your counter: waiting for the owner");
    expect(offerStatusLabel("expired", "buyer")).toBe("Expired");
    expect(offerStatusLabel("something_new", "owner")).toBe("something_new");
  });
});
