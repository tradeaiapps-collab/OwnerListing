import { describe, expect, it, vi } from "vitest";
import {
  BOOKING_LIMITS, buildInspectionPdf, buildOfferPdf, changeBooking, documentUrl, listPortal, offerDownload, parseBooking, parseBookingAction, portalAccess,
  requestBooking, sortDocuments, type ClientPortalRepository, type OfferForPdf, type PortalDocument
} from "../src/domain/client-portal";
import type { Actor } from "../src/domain/listing-service";
import type { ReportView } from "../src/domain/inspection";

const NOW = "2026-11-05T00:00:00.000Z";
const LISTING = "11111111-1111-4111-8111-111111111111";
const ids = { newId: () => "22222222-2222-4222-8222-222222222222", now: () => NOW };
const buyer: Actor = { userId: "b1", userType: "buyer" };
const text = (b: Uint8Array) => Buffer.from(b).toString("latin1");

const offer: OfferForPdf = {
  id: "o1", listingTitle: "Cottage", address: "1 Test St", priceCents: 90_000_000, depositCents: 9_000_000, settlementDays: 42, conditions: ["Finance approval"],
  status: "submitted", submittedAt: NOW, viewer: "buyer", buyerName: "Bea Buyer", events: [{ type: "submitted", at: NOW, priceCents: 90_000_000 }]
};

const repo = (over: Partial<ClientPortalRepository> = {}): ClientPortalRepository => ({
  documentsFor: async () => [], offerFor: async () => undefined, bookingsFor: async () => [],
  createBooking: async () => "created", transitionBooking: async () => true, ...over
});

describe("client portal rules", () => {
  it("keeps vendors out and lets buyers, owners and agents in", () => {
    expect(portalAccess({ userId: "v", userType: "vendor" })).toMatchObject({ code: "forbidden" });
    for (const t of ["buyer", "owner", "agent"] as const) expect(portalAccess({ userId: "x", userType: t })).toBeUndefined();
  });

  it("lists newest documents first with a stable tie-break and builds download links", () => {
    const d = (id: string, at: string): PortalDocument => ({ kind: "offer", id, title: "t", listingId: "l", listingTitle: "L", at, status: "s", downloadUrl: "" });
    expect(sortDocuments([d("b", "2026-01-01"), d("a", "2026-01-01"), d("c", "2026-02-01")]).map(x => x.id)).toEqual(["c", "a", "b"]);
    expect(documentUrl("offer", "x")).toBe("/api/client/portal/documents/offer/x");
    expect(documentUrl("signed", "x")).toBe("/api/signing-documents/x/pdf");
  });

  it("validates a booking request: kind, a valid time between an hour and 90 days away, a short note", () => {
    const at = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString();
    const ok = parseBooking({ listingId: LISTING, kind: "viewing", startsAt: at(2 * 3600_000), note: "  Bring a builder " }, NOW);
    expect(ok).toMatchObject({ ok: true, value: { kind: "viewing", note: "Bring a builder" } });
    expect(parseBooking(null, NOW)).toMatchObject({ ok: false });
    expect(parseBooking({ listingId: "nope", kind: "viewing", startsAt: at(7200_000) }, NOW)).toMatchObject({ ok: false });
    expect(parseBooking({ listingId: LISTING, kind: "tour", startsAt: at(7200_000) }, NOW)).toMatchObject({ ok: false });
    expect(parseBooking({ listingId: LISTING, kind: "viewing", startsAt: "soon" }, NOW)).toMatchObject({ ok: false });
    expect(parseBooking({ listingId: LISTING, kind: "viewing", startsAt: at(30 * 60_000) }, NOW)).toMatchObject({ ok: false });
    expect(parseBooking({ listingId: LISTING, kind: "viewing", startsAt: at(BOOKING_LIMITS.maxAheadMs + 1000) }, NOW)).toMatchObject({ ok: false });
    expect(parseBooking({ listingId: LISTING, kind: "viewing", startsAt: at(7200_000), note: "x".repeat(501) }, NOW)).toMatchObject({ ok: false });
  });

  it("accepts only the three booking actions", () => {
    expect(parseBookingAction({ action: "confirm" })).toBe("confirm");
    expect(parseBookingAction({ action: "delete" })).toBeUndefined();
    expect(parseBookingAction(null)).toBeUndefined();
  });

  it("maps repository outcomes to clear failures", async () => {
    const body = { listingId: LISTING, kind: "viewing", startsAt: new Date(Date.parse(NOW) + 7200_000).toISOString() };
    expect(await requestBooking(repo(), buyer, body, ids)).toMatchObject({ ok: true, value: { id: ids.newId() } });
    expect(await requestBooking(repo({ createBooking: async () => "duplicate" }), buyer, body, ids)).toMatchObject({ code: "conflict" });
    expect(await requestBooking(repo({ createBooking: async () => "too_many" }), buyer, body, ids)).toMatchObject({ code: "rate_limited" });
    expect(await requestBooking(repo({ createBooking: async () => "not_bookable" }), buyer, body, ids)).toMatchObject({ code: "not_found" });
    expect(await requestBooking(repo(), { userId: "v", userType: "vendor" }, body, ids)).toMatchObject({ code: "forbidden" });
  });

  it("changeBooking needs a valid id and action, and reports an unchangeable booking as not found", async () => {
    const id = LISTING;
    expect(await changeBooking(repo(), buyer, id, { action: "cancel" }, "c")).toMatchObject({ ok: true });
    expect(await changeBooking(repo(), buyer, id, { action: "x" }, "c")).toMatchObject({ code: "invalid" });
    expect(await changeBooking(repo(), buyer, "bad", { action: "cancel" }, "c")).toMatchObject({ code: "not_found" });
    expect(await changeBooking(repo({ transitionBooking: async () => false }), buyer, id, { action: "confirm" }, "c")).toMatchObject({ code: "not_found" });
  });

  it("listPortal and offerDownload go through the repository for the caller only", async () => {
    const documentsFor = vi.fn(async () => []);
    const offerFor = vi.fn(async (_u: string, id: string) => (id === LISTING ? offer : undefined));
    const r = repo({ documentsFor, offerFor });
    expect(await listPortal(r, buyer)).toMatchObject({ ok: true });
    expect(documentsFor).toHaveBeenCalledWith("b1");
    expect(await offerDownload(r, buyer, LISTING, NOW)).toMatchObject({ ok: true });
    expect(offerFor).toHaveBeenCalledWith("b1", LISTING);
    expect(await offerDownload(r, buyer, "33333333-3333-4333-8333-333333333333", NOW)).toMatchObject({ code: "not_found" });
    expect(await offerDownload(r, buyer, "not-a-uuid", NOW)).toMatchObject({ code: "not_found" });
    expect(await listPortal(r, { userId: "v", userType: "vendor" })).toMatchObject({ code: "forbidden" });
  });

  it("builds real PDFs; the owner's offer copy never names the buyer", () => {
    const buyerCopy = text(buildOfferPdf(offer, NOW));
    expect(buyerCopy.startsWith("%PDF-1.4")).toBe(true);
    expect(buyerCopy).toContain("Bea Buyer");
    expect(buyerCopy).toContain("$900,000");
    const ownerCopy = text(buildOfferPdf({ ...offer, viewer: "owner" }, NOW));
    expect(ownerCopy).not.toContain("Bea Buyer");
    expect(ownerCopy).toContain("identity withheld");
    expect(text(buildOfferPdf({ ...offer, conditions: ["(unbalanced \\ paren"] }, NOW))).toContain("\\(unbalanced \\\\ paren");
  });

  it("builds an inspection PDF with findings and the approved summary", () => {
    const report = {
      inspection: { id: "i1", listingTitle: "Cottage", inspectorName: "Ian", type: "building", scheduledAt: NOW, status: "completed", summary: { text: "Sound overall.", source: "rules", generatedAt: NOW, approved: true } },
      findings: [{ id: "f1", area: "Roof", title: "Cracked tiles", detail: "Replace soon", severity: "moderate" }]
    } as unknown as ReportView;
    const pdf = text(buildInspectionPdf(report, NOW));
    expect(pdf).toContain("Sound overall.");
    expect(pdf).toContain("[MODERATE] Roof: Cracked tiles");
    expect(text(buildInspectionPdf({ ...report, findings: [] } as ReportView, NOW))).toContain("No findings recorded.");
  });
});
