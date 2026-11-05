import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  aud, figuresView, leadStage, mapGoogleLead, mapMetaLead, normaliseEmail, normaliseInterest, normalisePhone, parseMetaWebhook, parseSourceInput,
  parseSpendInput, renderFollowup, verifyMetaSignature
} from "../src/domain/lead-ads";
import { metaConfig } from "../src/adapters/lead-providers";

describe("field clean-up", () => {
  it("normalises Australian and international phones and drops what it cannot trust", () => {
    expect(normalisePhone("0412 345 678")).toBe("+61412345678");
    expect(normalisePhone("(07) 3123 4567")).toBe("+61731234567");
    expect(normalisePhone("61412345678")).toBe("+61412345678");
    expect(normalisePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalisePhone("12345")).toBeNull();
    expect(normalisePhone("")).toBeNull();
  });
  it("accepts a plain email, lowercases it and refuses header-injection shapes", () => {
    expect(normaliseEmail(" Jo.Smith@Example.COM ")).toBe("jo.smith@example.com");
    expect(normaliseEmail("a@b")).toBeNull();
    expect(normaliseEmail("a@b.com\nbcc:x@y.com")).toBeNull();
    expect(normaliseEmail("x@y.com, z@y.com")).toBeNull();
  });
  it("reads the interest from free text", () => {
    expect(normaliseInterest("I want to buy")).toBe("buying");
    expect(normaliseInterest("Selling my home")).toBe("selling");
    expect(normaliseInterest("Looking to rent")).toBe("renting");
    expect(normaliseInterest("Free appraisal")).toBe("selling");
    expect(normaliseInterest("other")).toBeNull();
  });
});

describe("Meta", () => {
  it("lists only leadgen events from a webhook body", () => {
    const body = { object: "page", entry: [{ id: "P1", changes: [{ field: "leadgen", value: { leadgen_id: "L1", page_id: "P1", form_id: "F1", ad_id: "A1" } }, { field: "feed", value: {} }, { field: "leadgen", value: {} }] }, "junk"] };
    expect(parseMetaWebhook(body)).toEqual([{ leadgenId: "L1", pageId: "P1", formId: "F1", adId: "A1" }]);
    expect(parseMetaWebhook(null)).toEqual([]);
    expect(parseMetaWebhook({ entry: "x" })).toEqual([]);
  });
  it("verifies the signature in constant time and fails closed", () => {
    const raw = '{"a":1}';
    const good = "sha256=" + createHmac("sha256", "sekret").update(raw).digest("hex");
    expect(verifyMetaSignature(raw, good, "sekret")).toBe(true);
    expect(verifyMetaSignature(raw + " ", good, "sekret")).toBe(false);
    expect(verifyMetaSignature(raw, good, "other")).toBe(false);
    expect(verifyMetaSignature(raw, null, "sekret")).toBe(false);
    expect(verifyMetaSignature(raw, "sha256=zz", "sekret")).toBe(false);
    expect(verifyMetaSignature(raw, good, "")).toBe(false);
  });
  it("maps a Graph lead whatever the form's field names are", () => {
    const r = mapMetaLead({ id: "L9", ad_id: "A9", campaign_name: "Spring sellers", field_data: [
      { name: "full_name", values: ["Jo Smith"] }, { name: "email", values: ["JO@x.com"] }, { name: "phone_number", values: ["0412345678"] },
      { name: "what_are_you_interested_in?", values: ["Selling"] }, { name: "post_code", values: ["4064"] }, { name: "city", values: ["Paddington"] }] });
    expect(r).toEqual({ ok: true, value: { externalId: "L9", name: "Jo Smith", email: "jo@x.com", phone: "+61412345678", interest: "selling", suburb: "Paddington", postcode: "4064", propertyType: null, campaignRef: "Spring sellers", adRef: "A9", isTest: false } });
  });
  it("builds a name from first and last, and rejects a lead with no way to contact", () => {
    const ok = mapMetaLead({ id: "1", field_data: [{ name: "first_name", values: ["Jo"] }, { name: "last_name", values: ["Smith"] }, { name: "email", values: ["j@x.com"] }] });
    expect(ok.ok && ok.value.name).toBe("Jo Smith");
    expect(mapMetaLead({ id: "1", field_data: [{ name: "full_name", values: ["Jo"] }] })).toEqual({ ok: false, error: "The lead has no usable email or phone." });
    expect(mapMetaLead({ field_data: [{ name: "email", values: ["j@x.com"] }] }).ok).toBe(false);
    expect(mapMetaLead("x").ok).toBe(false);
  });
  it("needs all three settings", () => {
    expect(metaConfig({ META_APP_SECRET: "a", META_WEBHOOK_VERIFY_TOKEN: "b" })).toBeNull();
    expect(metaConfig({ META_APP_SECRET: "a", META_WEBHOOK_VERIFY_TOKEN: "b", META_PAGE_ACCESS_TOKEN: "c" })).toEqual({ appSecret: "a", verifyToken: "b", pageToken: "c" });
  });
});

describe("Google", () => {
  it("maps the standard columns, a custom question and the test flag", () => {
    const r = mapGoogleLead({ lead_id: "g1", google_key: "k", is_test: true, campaign_id: 77, creative_id: 5, user_column_data: [
      { column_id: "FULL_NAME", string_value: "Sam Lee" }, { column_id: "EMAIL", string_value: "sam@x.com" }, { column_id: "PHONE_NUMBER", string_value: "+61 400 111 222" },
      { column_id: "POSTAL_CODE", string_value: "4000" }, { column_id: "QUESTION_1", column_name: "Are you buying or selling?", string_value: "Buying" }] });
    expect(r.googleKey).toBe("k");
    expect(r.lead).toEqual({ ok: true, value: { externalId: "g1", name: "Sam Lee", email: "sam@x.com", phone: "+61400111222", interest: "buying", suburb: null, postcode: "4000", propertyType: null, campaignRef: "77", adRef: "5", isTest: true } });
  });
  it("reports an unreadable body without throwing", () => {
    expect(mapGoogleLead(null).lead.ok).toBe(false);
    expect(mapGoogleLead({ lead_id: "x", user_column_data: [] }).lead.ok).toBe(false);
  });
});

describe("staff input", () => {
  it("validates a source", () => {
    expect(parseSourceInput({ provider: "meta", label: "Page", accountRef: "108234567890123" })).toEqual({ ok: true, value: { provider: "meta", label: "Page", accountRef: "108234567890123", defaultAgentId: null, followupMode: "off" } });
    const g = parseSourceInput({ provider: "google", label: "Ads", accountRef: "123-456-7890", followupMode: "matches" });
    expect(g.ok && g.value.accountRef).toBe("1234567890");
    expect(parseSourceInput({ provider: "meta", label: "x", accountRef: "1" }).ok).toBe(false);
    expect(parseSourceInput({ provider: "tiktok", label: "Page", accountRef: "12345" }).ok).toBe(false);
    expect(parseSourceInput({ provider: "meta", label: "Page", accountRef: "abc12345" }).ok).toBe(false);
    expect(parseSourceInput({ provider: "meta", label: "Page", accountRef: "12345", followupMode: "spam" }).ok).toBe(false);
    expect(parseSourceInput({ provider: "meta", label: "Page", accountRef: "12345", defaultAgentId: "nope" }).ok).toBe(false);
  });
  it("validates spend rows", () => {
    expect(parseSpendInput({ rows: [{ day: "2026-11-05", spend: 123.45 }] })).toEqual({ ok: true, value: { rows: [{ day: "2026-11-05", spendCents: 12345 }] } });
    expect(parseSpendInput({ rows: [] }).ok).toBe(false);
    expect(parseSpendInput({ rows: [{ day: "2026-02-30", spend: 1 }] }).ok).toBe(false);
    expect(parseSpendInput({ rows: [{ day: "2026-11-05", spend: -1 }] }).ok).toBe(false);
    expect(parseSpendInput({ rows: [{ day: "2026-11-05", spend: "abc" }] }).ok).toBe(false);
    expect(parseSpendInput({ rows: [{ day: "2026-11-05", spend: 1 }, { day: "2026-11-05", spend: 2 }] }).ok).toBe(false);
  });
});

describe("figures", () => {
  it("never shows a cost or rate it cannot compute", () => {
    expect(figuresView({ leads: 0, contacted: 0, enquired: 0, offered: 0, spendCents: 5000 })).toMatchObject({ costPerLeadCents: null, contactRate: null, enquiryRate: null });
    expect(figuresView({ leads: 10, contacted: 5, enquired: 2, offered: 1, spendCents: 0 })).toMatchObject({ costPerLeadCents: null, costPerEnquiryCents: null, enquiryRate: 0.2 });
    expect(figuresView({ leads: 10, contacted: 5, enquired: 2, offered: 1, spendCents: 10000 })).toMatchObject({ costPerLeadCents: 1000, costPerEnquiryCents: 5000, contactRate: 0.5, offerRate: 0.1 });
  });
  it("takes the furthest stage and formats money", () => {
    expect(leadStage({ status: "new", enquired: false, offered: false })).toBe("new");
    expect(leadStage({ status: "contacted", enquired: true, offered: false })).toBe("enquiry");
    expect(leadStage({ status: "lost", enquired: true, offered: true })).toBe("offer");
    expect(aud(1000)).toBe("$10");
    expect(aud(1050)).toBe("$10.50");
    expect(aud(null)).toBe("—");
  });
});

describe("follow-up email", () => {
  const base = { brand: "OwnerListing", appUrl: "https://app.test/", leadName: "Jo <b>Smith</b>", interest: "buying" as const, agent: { name: "Ann Agent", email: "ann@x.com" } };
  it("lists up to three matches with links and the agent's contact, and escapes everything", () => {
    const m = (i: number) => ({ id: `id${i}`, title: `Home ${i} <script>`, address: "1 A St", priceCents: 90000000, transactionType: "sale" as const });
    const e = renderFollowup({ ...base, matches: [m(1), m(2), m(3), m(4)] });
    expect(e.text).toContain("https://app.test/listings/id1");
    expect(e.text).not.toContain("id4");
    expect(e.text).toContain("Ann Agent will be in touch, or you can write to ann@x.com");
    expect(e.html).not.toContain("<script>");
    expect(e.html).not.toContain("<b>Smith");
  });
  it("falls back to a plain thank-you with rent shown weekly", () => {
    const e = renderFollowup({ ...base, agent: null, matches: [{ id: "r1", title: "Unit", address: "2 B St", priceCents: 65000, transactionType: "rent" }] });
    expect(e.text).toContain("$650 a week");
    expect(e.text).toContain("One of our team will be in touch soon.");
    expect(renderFollowup({ ...base, matches: [] }).text).not.toContain("properties that may suit");
  });
});
