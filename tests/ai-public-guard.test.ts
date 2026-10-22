import { describe, expect, it } from "vitest";
import { checkPublicOutput } from "../src/domain/ai-public-guard";

describe("checkPublicOutput", () => {
  it("allows general information and rough ranges", () => {
    expect(checkPublicOutput("A household earning $120k might borrow roughly 5 to 6 times income. Speak to a broker.").ok).toBe(true);
  });
  it("blocks personal amounts and recommendations", () => {
    expect(checkPublicOutput("You can borrow $620,000.").ok).toBe(false);
    expect(checkPublicOutput("I recommend the Acme Bank variable loan.").ok).toBe(false);
    expect(checkPublicOutput("This is the best loan for you.").ok).toBe(false);
  });
  it("blocks named lenders from a configured list", () => {
    expect(checkPublicOutput("Try AcmeBank.", ["AcmeBank"]).ok).toBe(false);
  });
});
