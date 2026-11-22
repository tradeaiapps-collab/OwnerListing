import { describe, expect, it } from "vitest";
import { buildStats, formatPrice, formatResponse, parseContractorNumber, parseJobNumber, parsePageInput, parseReview, rankContractors, uploadKindFor } from "../src/domain/contractor-market";
import { card } from "./helpers/market-memory";

describe("numbers", () => {
  it("finds a job number in a subject or reply, in any case", () => {
    expect(parseJobNumber("Re: JOB-5001 photos for 12 Smith St")).toBe(5001);
    expect(parseJobNumber("job 5002")).toBe(5002);
    expect(parseJobNumber("Order 123456 and JOB-5007.")).toBe(5007);
    expect(parseJobNumber("no number here JOB-12")).toBeUndefined();
    expect(parseJobNumber("XJOB-5001")).toBeUndefined();
  });
  it("reads contractor numbers", () => {
    expect(parseContractorNumber("CON-2001")).toBe(2001);
    expect(parseContractorNumber(" 2001 ")).toBe(2001);
    expect(parseContractorNumber("2001; DROP")).toBeUndefined();
  });
});

describe("price text", () => {
  it("shows the contractor's displayed price", () => {
    expect(formatPrice(18000)).toBe("$180");
    expect(formatPrice(18050, "from")).toBe("from $180.50");
    expect(formatPrice(9000, "per_hour")).toBe("$90 per hour");
  });
});

describe("parsePageInput", () => {
  const ok = { businessName: "Pat Photo", services: [{ kind: "photographer", name: "Photos", priceDollars: 180, priceType: "fixed" }], media: [{ mediaType: "photo", url: "https://x.test/a.jpg", caption: "Kitchen" }], isPublic: true };
  it("accepts a page and stores prices in cents", () => {
    const r = parsePageInput(ok);
    expect(r.ok && r.value.services[0]).toMatchObject({ priceCents: 18000, kind: "photographer" });
  });
  it("refuses bad trades, negative prices, non-https links and bad states", () => {
    expect(parsePageInput({ ...ok, services: [{ kind: "plumber", name: "x", priceDollars: 1 }] }).ok).toBe(false);
    expect(parsePageInput({ ...ok, services: [{ kind: "photographer", name: "x", priceDollars: -1 }] }).ok).toBe(false);
    expect(parsePageInput({ ...ok, media: [{ mediaType: "photo", url: "http://x.test/a.jpg" }] }).ok).toBe(false);
    expect(parsePageInput({ ...ok, media: [{ mediaType: "photo", url: "javascript:alert(1)" }] }).ok).toBe(false);
    expect(parsePageInput({ ...ok, licenceState: "ZZZ" }).ok).toBe(false);
    expect(parsePageInput({ ...ok, about: "x".repeat(3001) }).ok).toBe(false);
  });
});

describe("buildStats", () => {
  it("computes completion rate from accepted jobs and rounds the rating", () => {
    const s = buildStats({ received: 10, accepted: 8, rejected: 2, completed: 6, pending: 0, thisMonth: 3, avgResponseMinutes: 42.4 }, { avg: 4.666, count: 3 });
    expect(s).toMatchObject({ completionRate: 75, avgResponseMinutes: 42, ratingAvg: 4.7, ratingCount: 3 });
  });
  it("shows no rate or rating until there is something to show", () => {
    const s = buildStats({ received: 1, accepted: 0, rejected: 0, completed: 0, pending: 1, thisMonth: 1, avgResponseMinutes: null }, { avg: null, count: 0 });
    expect(s.completionRate).toBeNull(); expect(s.ratingAvg).toBeNull();
    expect(formatResponse(null)).toBe("No answers yet"); expect(formatResponse(90)).toBe("1.5 hours");
  });
});

describe("rankContractors", () => {
  const area = { suburb: "Paddington", postcode: "4064" };
  it("only suggests contractors who work in the area and take new jobs", () => {
    const list = [card(2), card(3, { suburbs: ["Toowong"], postcodes: ["4066"] }), card(4, { acceptingNew: false })];
    expect(rankContractors(area, list).map(r => r.card.userId)).toEqual([card(2).userId]);
  });
  it("prefers a suburb match, better rating, lower price and a lighter load, repeatably", () => {
    const list = [card(2, { ratingAvg: 3, ratingCount: 4 }), card(3, { ratingAvg: 4.8, ratingCount: 9, fromPriceCents: 19000 }), card(4, { suburbs: [], ratingAvg: 2, ratingCount: 20, fromPriceCents: 30000 })];
    const r = rankContractors(area, list);
    expect(r[0]!.card.userId).toBe(card(3).userId);
    expect(r.at(-1)!.card.userId).toBe(card(4).userId);
    expect(r[0]!.reasons).toContain("Works in your suburb");
    expect(rankContractors(area, [...list].reverse()).map(x => x.card.userId)).toEqual(r.map(x => x.card.userId));
  });
});

describe("uploadKindFor", () => {
  it("maps each trade's files to the right kind and refuses the rest", () => {
    expect(uploadKindFor("photographer", "image/jpeg", "kitchen.jpg")).toBe("photo");
    expect(uploadKindFor("photographer", "video/mp4", "tour.mp4")).toBe("video");
    expect(uploadKindFor("photographer", "application/pdf", "floorplan.pdf")).toBe("floorplan");
    expect(uploadKindFor("photographer", "application/pdf", "invoice.pdf")).toBeUndefined();
    expect(uploadKindFor("inspector", "application/pdf", "Building report.pdf")).toBe("building_inspection");
    expect(uploadKindFor("inspector", "application/pdf", "pest.pdf")).toBe("pest_report");
    expect(uploadKindFor("inspector", "image/jpeg", "x.jpg")).toBeUndefined();
    expect(uploadKindFor("pest_control", "application/pdf", "r.pdf")).toBe("pest_report");
    expect(uploadKindFor("solicitor", "application/pdf", "c.pdf")).toBeUndefined();
  });
});

describe("parseReview", () => {
  it("needs 1 to 5 whole stars", () => {
    expect(parseReview({ rating: 5, body: " great " })).toEqual({ ok: true, value: { rating: 5, body: "great" } });
    expect(parseReview({ rating: 0 }).ok).toBe(false);
    expect(parseReview({ rating: 4.5 }).ok).toBe(false);
    expect(parseReview({ rating: 3, body: "x".repeat(1001) }).ok).toBe(false);
  });
});
