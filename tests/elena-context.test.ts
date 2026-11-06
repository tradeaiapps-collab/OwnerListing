import { describe, expect, it } from "vitest";
import { isListingForm, isWhereQuestion, pageLabel, whereAnswer, roomsFromText, sectionHint, sectionOfField } from "../src/domain/elena-context";

describe("Elena context", () => {
  it("names the page", () => {
    expect(pageLabel("/listings/new")).toBe("Create a listing");
    expect(pageLabel("/listings/abc/edit")).toBe("Edit listing");
    expect(pageLabel("/messages/x?y=1")).toBe("Messages");
    expect(pageLabel("/nowhere")).toBe("Nowhere");
    expect(pageLabel("/staff")).toBe("Staff home");
    expect(pageLabel("/staff/investments/settings")).toBe("Investor module settings");
    expect(pageLabel("/staff/some-new/page-x")).toBe("Staff console");
    expect(pageLabel("/zz/open-things/12345678-1234-1234-1234-123456789012")).toBe("Zz, open things");
  });
  it("answers where am I", () => {
    expect(isWhereQuestion("what page am i on")).toBe(true);
    expect(isWhereQuestion("Where am I?")).toBe(true);
    expect(isWhereQuestion("what are the fees")).toBe(false);
    expect(whereAnswer({ path: "/staff", pageLabel: "Staff home", sectionLabel: "" })).toBe("You are on Staff home (/staff).");
    expect(whereAnswer({ path: "/x", pageLabel: "this page", sectionLabel: "Price" })).toBe("You are on /x. You last touched Price.");
  });
  it("knows the listing form", () => {
    expect(isListingForm("/listings/new")).toBe(true);
    expect(isListingForm("/listings/abc/edit")).toBe(true);
    expect(isListingForm("/listings/abc")).toBe(false);
  });
  it("maps fields to sections", () => {
    expect(sectionOfField("price")).toBe("price");
    expect(sectionOfField("bedrooms")).toBe("features");
    expect(sectionOfField("nope")).toBeUndefined();
  });
  it("changes the hint with what is empty", () => {
    const e = { price: true, description: true, rooms: true };
    expect(sectionHint("price", e)?.action?.id).toBe("pricing");
    expect(sectionHint("description", e)?.action?.id).toBe("tell");
    expect(sectionHint("description", { ...e, description: false })?.action?.id).toBe("rewrite");
    expect(sectionHint("unknown", e)).toBeUndefined();
  });
  it("reads rooms only from the owner's words", () => {
    expect(roomsFromText("Lovely 3 bed, 2 bathrooms and double car garage")).toEqual({ bedrooms: 3, bathrooms: 2 });
    expect(roomsFromText("four bedroom home with 2 car spaces")).toEqual({ bedrooms: 4, parking: 2 });
    expect(roomsFromText("nice house")).toEqual({});
    expect(roomsFromText("99 bedrooms")).toEqual({});
  });
});
