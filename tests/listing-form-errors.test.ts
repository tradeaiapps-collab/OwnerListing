import { describe, expect, it } from "vitest";
import { listingFormBody } from "../app/listings/ui";

const form = (o: Record<string, string>) => { const fd = new FormData(); for (const [k, v] of Object.entries(o)) fd.set(k, v); return fd; };

describe("listingFormBody field errors", () => {
  it("returns one message per bad field so the form can mark each", () => {
    const r = listingFormBody(form({ title: " ", address: "", postcode: "40", price: "abc", bedrooms: "x" }));
    expect("errors" in r && Object.keys(r.errors).sort()).toEqual(["address", "bedrooms", "postcode", "price", "title"]);
  });
  it("accepts a valid form", () => {
    const r = listingFormBody(form({ title: "House", address: "1 A St", postcode: "4000", price: "850000" }));
    expect("body" in r && r.body["priceCents"]).toBe(85000000);
  });
});
