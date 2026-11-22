import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLocalDiskStorage } from "../src/adapters/object-storage";
import { certificateFlags, effectiveDates, milestoneFor, parseCertificateFields, reminderText } from "../src/domain/contractor-certificates";
import { KINDS, planChannels, defaultPreferences, renderNotification } from "../src/domain/notifications";
import { verificationState } from "../src/domain/contractor-trust";
import { VENDOR_API_PREFIXES, vendorMayCall } from "../src/domain/contractor-access";

const TODAY = "2026-11-21";

describe("expiry reminder steps", () => {
  it("picks the one step that applies: 30 days, 7 days, expired, or nothing yet", () => {
    expect(milestoneFor("2027-03-01", TODAY)).toBeNull();
    expect(milestoneFor("2026-12-21", TODAY)).toBe(30);
    expect(milestoneFor("2026-12-14", TODAY)).toBe(30);
    expect(milestoneFor("2026-11-28", TODAY)).toBe(7);
    expect(milestoneFor("2026-11-21", TODAY)).toBe(7); // the date itself is still in date
    expect(milestoneFor("2026-11-20", TODAY)).toBe(0);
    expect(milestoneFor("2025-01-01", TODAY)).toBe(0);
  });
  it("wording names the date and the consequence", () => {
    expect(reminderText("insurance", "2026-12-01", 30).text).toContain("2026-12-01");
    expect(reminderText("licence", "2026-12-01", 7).title).toContain("7 days");
    expect(reminderText("insurance", "2026-11-01", 0).text).toMatch(/badge is off.*Elena will not invite/);
  });
  it("the notices are required account messages: email cannot be turned off", () => {
    expect(KINDS.cert_expiring).toBe("account");
    expect(KINDS.cert_expired).toBe("account");
    expect(planChannels("cert_expiring", defaultPreferences(), true)).toEqual({ inApp: true, email: true, sms: false });
    const n = renderNotification("cert_expired", { title: "T", text: "B", link: "/contractor/trust" });
    expect(n).toMatchObject({ title: "T", body: "B", link: "/contractor/trust", smsText: null });
  });
});

describe("certificate fields", () => {
  it("accepts a kind and a real future date", () => {
    expect(parseCertificateFields("insurance", "2027-01-31", TODAY)).toEqual({ ok: true, value: { kind: "insurance", expiry: "2027-01-31" } });
    expect(parseCertificateFields("licence", TODAY, TODAY).ok).toBe(true);
  });
  it("refuses unknown kinds, bad or impossible dates, expired and far-future dates", () => {
    for (const [k, d] of [["passport", "2027-01-01"], ["insurance", "01/02/2027"], ["insurance", "2027-02-30"], ["insurance", "2026-11-20"], ["insurance", "2099-01-01"], [undefined, "2027-01-01"], ["insurance", undefined], ["insurance", 5]] as const) {
      expect(parseCertificateFields(k, d, TODAY).ok, `${String(k)} ${String(d)}`).toBe(false);
    }
  });
});

describe("staff flags and the effective dates", () => {
  it("flags a missing file and a date that disagrees; says nothing when there is no declared date", () => {
    expect(certificateFlags("insurance", "2027-03-01", undefined)).toEqual(["No insurance certificate file uploaded."]);
    expect(certificateFlags("insurance", "2027-03-01", { expiry: "2027-03-01" })).toEqual([]);
    expect(certificateFlags("licence", "2027-03-01", { expiry: "2026-12-01" })[0]).toContain("2026-12-01");
    expect(certificateFlags("licence", null, undefined)).toEqual([]);
  });
  it("the earlier of the typed date and the file's date decides the badge", () => {
    const v = { status: "verified", insuranceExpiry: "2027-03-01", licenceExpiry: null as string | null };
    expect(verificationState(v, TODAY).badge).toBe(true);
    expect(verificationState(effectiveDates(v, { insurance: "2026-11-01" }), TODAY)).toMatchObject({ badge: false, insuranceExpired: true });
    expect(effectiveDates(v, { insurance: "2028-01-01" }).insuranceExpiry).toBe("2027-03-01");
    expect(effectiveDates(v, undefined)).toBe(v);
    expect(effectiveDates(v, { licence: "2026-10-01" }).licenceExpiry).toBe("2026-10-01");
  });
});

describe("contractor access", () => {
  it("contractors may reach the certificate routes and nothing else new", () => {
    expect(VENDOR_API_PREFIXES).toContain("/api/contractor/");
    expect(vendorMayCall("/api/contractor/certificates")).toBe(true);
    expect(vendorMayCall("/api/contractor/certificates/abc/file")).toBe(true);
    expect(vendorMayCall("/api/staff/contractors/certificates/abc/file")).toBe(false);
  });
});

describe("storage keys", () => {
  it("accepts cert/<user>/<random> and still refuses other shapes and deletes", async () => {
    const s = createLocalDiskStorage(mkdtempSync(path.join(os.tmpdir(), "cert-")));
    const key = "cert/55555555-5555-4555-8555-555555555555/66666666-6666-4666-8666-666666666666";
    await s.put(key, Uint8Array.from([1, 2]), "application/pdf");
    expect(Array.from(await s.get(key))).toEqual([1, 2]);
    await expect(s.get("cert/../x/y")).rejects.toThrow(/Invalid storage key/);
    await expect(s.get("certs/a/b")).rejects.toThrow(/Invalid storage key/);
    await expect(s.remove!(key)).rejects.toThrow(/Only identity images/);
  });
});
