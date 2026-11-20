import { describe, expect, it } from "vitest";
import {
  areaScore, cleanPhone, composeContractorMessage, describeHours, isAvailableNow, mobileE164, parseEmergencyProfile, parseEmergencyRequest, parseReply,
  pickRecipients, requestRateOk, searchEmergency, EMERGENCY_LIMITS, type EmergencyCandidate, type EmergencyProfile
} from "../src/domain/emergency";

const profile = (o: Partial<EmergencyProfile> = {}): EmergencyProfile => ({
  trade: "plumber", enabled: true, timeZone: "Australia/Brisbane", allHours: false, windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "18:00", end: "06:00" }],
  callOutCents: 18000, businessName: null, contactPhone: "0412345678", contactEmail: null, note: null, serviceSuburbs: ["Paddington"], servicePostcodes: ["4064"], ...o
});
const cand = (n: number, o: Partial<EmergencyProfile> = {}, messagesToday = 0): EmergencyCandidate =>
  ({ userId: `00000000-0000-4000-8000-00000000000${n}`, displayName: `Pro ${n}`, profile: profile(o), messagesToday });

// 2026-11-20T10:00Z is 20:00 Friday in Brisbane (UTC+10, no daylight saving) and 21:00 Friday in Sydney (UTC+11).
const FRI_8PM_BNE = "2026-11-20T10:00:00.000Z";
const SAT_3AM_BNE = "2026-11-20T17:00:00.000Z";
const FRI_NOON_BNE = "2026-11-20T02:00:00.000Z";

describe("isAvailableNow", () => {
  it("honours the contractor's own time zone and windows that cross midnight", () => {
    const p = profile();
    expect(isAvailableNow(p, FRI_8PM_BNE)).toBe(true);
    expect(isAvailableNow(p, SAT_3AM_BNE)).toBe(true);
    expect(isAvailableNow(p, FRI_NOON_BNE)).toBe(false);
    // Same instant, Sydney is an hour ahead: 21:00 is still inside 18:00 to 06:00, and 02:00 UTC is 13:00 there.
    expect(isAvailableNow(profile({ timeZone: "Australia/Sydney" }), FRI_NOON_BNE)).toBe(false);
  });
  it("a window past midnight belongs to the day it starts on", () => {
    const p = profile({ windows: [{ days: [5], start: "22:00", end: "04:00" }] }); // Friday night only
    expect(isAvailableNow(p, "2026-11-20T13:00:00.000Z")).toBe(true); // Fri 23:00 Brisbane
    expect(isAvailableNow(p, "2026-11-20T17:00:00.000Z")).toBe(true); // Sat 03:00 Brisbane
    expect(isAvailableNow(p, "2026-11-21T13:00:00.000Z")).toBe(false); // Sat 23:00 Brisbane
  });
  it("same-day windows are end-exclusive; disabled, bad zones and bad times fail closed; all hours is always on", () => {
    const p = profile({ windows: [{ days: [5], start: "08:00", end: "12:00" }] });
    expect(isAvailableNow(p, "2026-11-19T22:00:00.000Z")).toBe(true); // Fri 08:00
    expect(isAvailableNow(p, "2026-11-20T02:00:00.000Z")).toBe(false); // Fri 12:00
    expect(isAvailableNow(profile({ enabled: false, allHours: true }), FRI_8PM_BNE)).toBe(false);
    expect(isAvailableNow(profile({ timeZone: "Nowhere/Land" }), FRI_8PM_BNE)).toBe(false);
    expect(isAvailableNow(profile(), "not a time")).toBe(false);
    expect(isAvailableNow(profile({ allHours: true, windows: [] }), FRI_NOON_BNE)).toBe(true);
  });
});

describe("search and recipients", () => {
  const list = [
    cand(1, { windows: [{ days: [5], start: "08:00", end: "12:00" }] }),             // not available at 20:00
    cand(2, { callOutCents: 25000 }),                                                  // available, dearer
    cand(3, { callOutCents: 15000, serviceSuburbs: [], servicePostcodes: ["4064"] }),   // available, postcode only, cheaper
    cand(4, { trade: "electrician" }),
    cand(5, { enabled: false }),
    cand(6, { serviceSuburbs: ["Toowong"], servicePostcodes: ["4066"] })
  ];
  it("puts available-now first, then the better area match, then price", () => {
    const r = searchEmergency(list, { trade: "plumber", suburb: "paddington", postcode: "4064" }, FRI_8PM_BNE);
    expect(r.map(x => x.userId.slice(-1))).toEqual(["2", "3", "1"]);
    expect(r.map(x => x.availableNow)).toEqual([true, true, false]);
  });
  it("without an area it lists every enabled contractor of the trade", () => {
    expect(searchEmergency(list, { trade: "plumber" }, FRI_8PM_BNE).map(x => x.userId.slice(-1))).toEqual(["3", "6", "2", "1"]);
    expect(areaScore(profile(), { suburb: "Paddington", postcode: "4064" })).toBe(3);
  });
  it("only asks available, nearby, under-cap contractors, never the requester, never more than the limit", () => {
    const many = Array.from({ length: 9 }, (_, i) => cand(i + 1));
    expect(pickRecipients({ trade: "plumber", suburb: "Paddington" }, many, FRI_8PM_BNE, many[0]!.userId)).toHaveLength(EMERGENCY_LIMITS.contractorsPerRequest);
    const picked = pickRecipients({ trade: "plumber", suburb: "Paddington", postcode: "4064" }, list.concat(cand(7, {}, EMERGENCY_LIMITS.contractorMessagesPerDay)), FRI_8PM_BNE, list[1]!.userId);
    expect(picked.map(x => x.userId.slice(-1))).toEqual(["3"]);
    expect(pickRecipients({ trade: "plumber", suburb: "Toowong" }, [cand(1, { serviceSuburbs: ["Paddington"], servicePostcodes: [] })], FRI_8PM_BNE, "x")).toEqual([]);
  });
});

describe("parseEmergencyProfile", () => {
  const body = { trade: "plumber", enabled: true, timeZone: "Australia/Brisbane", allHours: false, windows: [{ days: [1, 1, 0], start: "18:00", end: "06:00" }], callOutCents: 18000, contactPhone: "0412 345 678", serviceSuburbs: ["Paddington"], servicePostcodes: ["4064"] };
  it("accepts a good profile and cleans it", () => {
    const r = parseEmergencyProfile(body);
    expect(r.ok && r.value.windows[0]!.days).toEqual([0, 1]);
    expect(r.ok && r.value.contactPhone).toBe("0412345678");
  });
  it("refuses bad input", () => {
    for (const bad of [
      { ...body, trade: "dentist" }, { ...body, timeZone: "Mars/Base" }, { ...body, windows: [] }, { ...body, windows: [{ days: [7], start: "18:00", end: "06:00" }] },
      { ...body, windows: [{ days: [1], start: "18:00", end: "18:00" }] }, { ...body, windows: [{ days: [1], start: "6pm", end: "06:00" }] },
      { ...body, contactPhone: "123" }, { ...body, callOutCents: -1 }, { ...body, servicePostcodes: ["40"] }, { ...body, serviceSuburbs: [], servicePostcodes: [] },
      { ...body, note: "call me on 0412 345 678" }, { ...body, businessName: "visit www.example.com" }, { ...body, contactEmail: "nope" }, null
    ]) expect(parseEmergencyProfile(bad).ok).toBe(false);
    expect(parseEmergencyProfile({ ...body, windows: [], allHours: true }).ok).toBe(true);
    expect(parseEmergencyProfile({ ...body, enabled: false, windows: [], serviceSuburbs: [], servicePostcodes: [] }).ok).toBe(true);
  });
  it("describes hours and phones", () => {
    expect(describeHours(profile())).toBe("Sun, Mon, Tue, Wed, Thu, Fri, Sat 18:00 to 06:00");
    expect(cleanPhone("+61 412 345 678")).toBe("0412345678");
    expect(cleanPhone("1300 123 456")).toBe("1300123456");
    expect(mobileE164("0412345678")).toBe("+61412345678");
    expect(mobileE164("0733334444")).toBeUndefined();
  });
});

describe("parseEmergencyRequest", () => {
  const ok = { trade: "plumber", description: "Water is coming through the kitchen ceiling", addressText: "12 Example St", suburb: "Paddington", postcode: "4064" };
  it("needs a trade, a description and a place; refuses contact details and abuse in the text", () => {
    expect(parseEmergencyRequest(ok).ok).toBe(true);
    expect(parseEmergencyRequest({ ...ok, description: "short" }).ok).toBe(false);
    expect(parseEmergencyRequest({ ...ok, description: "Burst pipe, ring me on 0412 345 678 now" }).ok).toBe(false);
    expect(parseEmergencyRequest({ ...ok, description: "Burst pipe, see http://evil.example.com now" }).ok).toBe(false);
    expect(parseEmergencyRequest({ ...ok, suburb: undefined, postcode: undefined }).ok).toBe(false);
    expect(parseEmergencyRequest({ ...ok, addressText: "" }).ok).toBe(false);
    expect(parseEmergencyRequest({ ...ok, trade: "chef" }).ok).toBe(false);
    expect(parseEmergencyRequest({ ...ok, callbackPhone: "12" }).ok).toBe(false);
    const r = parseEmergencyRequest({ ...ok, callbackPhone: "0412 345 678" });
    expect(r.ok && r.value.callbackPhone).toBe("0412345678");
    expect(parseEmergencyRequest({ trade: "plumber", description: "Water is coming through the kitchen ceiling", listingId: "00000000-0000-4000-8000-000000000001" }).ok).toBe(true);
  });
});

describe("limits and messages", () => {
  it("rate limits requests per hour and per day", () => {
    const now = "2026-11-20T10:00:00.000Z";
    expect(requestRateOk([], now).ok).toBe(true);
    expect(requestRateOk(["2026-11-20T09:30:00.000Z", "2026-11-20T09:40:00.000Z"], now).ok).toBe(false);
    expect(requestRateOk(["2026-11-20T01:00:00.000Z", "2026-11-20T02:00:00.000Z", "2026-11-20T03:00:00.000Z"], now).ok).toBe(true);
    expect(requestRateOk(["2026-11-20T01:00:00.000Z", "2026-11-20T02:00:00.000Z", "2026-11-20T03:00:00.000Z", "2026-11-20T04:00:00.000Z"], now).ok).toBe(false);
  });
  it("the contractor message states only the request's facts and leaves out the street address and callback number", () => {
    const m = composeContractorMessage({ number: 5001, trade: "plumber", description: "Water through the ceiling", suburb: "Paddington", postcode: "4064", propertyKind: "rental", requesterFirstName: "Dana", brand: "OwnerListing" }, "https://x.example/contractor/emergency");
    expect(m.subject).toBe("Urgent plumber request EMG-5001 in Paddington 4064");
    expect(m.text).toContain("Dana wrote: \"Water through the ceiling\"");
    expect(m.text).toContain("a rental property in Paddington 4064");
    expect(m.text).toContain("directly to you");
    expect(m.sms.length).toBeLessThanOrEqual(160);
  });
  it("replies are accept or decline with a clean note", () => {
    expect(parseReply({ kind: "accept", etaMinutes: 30 }).ok).toBe(true);
    expect(parseReply({ kind: "accept", etaMinutes: 0 }).ok).toBe(false);
    expect(parseReply({ kind: "maybe" }).ok).toBe(false);
    expect(parseReply({ kind: "decline", note: "call 0412 345 678" }).ok).toBe(false);
  });
});
