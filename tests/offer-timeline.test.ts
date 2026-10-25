import { describe, expect, it } from "vitest";
import { describeEvent } from "../src/domain/offer-timeline";

describe("offer timeline wording", () => {
  it("tells each side what happened, by role only", () => {
    expect(describeEvent({ type: "submitted", actor: "buyer" }, "owner")).toBe("The buyer made a formal offer");
    expect(describeEvent({ type: "submitted", actor: "buyer" }, "buyer")).toBe("You made a formal offer");
    expect(describeEvent({ type: "owner_countered", actor: "owner", round: 1 }, "buyer")).toBe("The owner sent a counter-offer (round 1)");
    expect(describeEvent({ type: "buyer_agreed", actor: "buyer", round: 3 }, "owner")).toBe("The buyer agreed to the owner's counter-offer (round 3)");
    expect(describeEvent({ type: "accepted", actor: "owner" }, "owner")).toBe("You accepted the offer");
    expect(describeEvent({ type: "expired", actor: "system", round: 2 }, "owner")).toBe("The counter-offer (round 2) lapsed without a reply, so the offer expired");
    expect(describeEvent({ type: "countered", actor: "owner" }, "buyer")).toBe("The owner asked for a better offer");
    expect(describeEvent({ type: "unknown", actor: "system" }, "buyer")).toBe("Status changed");
  });
});
