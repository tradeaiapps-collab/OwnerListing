import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MalwareScanPort } from "../src/adapters/malware-scan";
import type { ObjectStoragePort } from "../src/adapters/object-storage";
import { addCertificatePg, certificateFilePg, currentCertificatesPg, listCertificatesPg, runCertificateExpiryNotices } from "../src/server/contractor-certificates-db";
import { uploadCertificate } from "../src/server/contractor-certificate-service";
import { decideVerificationPg, listVerificationsPg, publicTrustPg, setSuspensionPg, submitVerificationPg } from "../src/server/contractor-trust-db";
import { notSuspendedSql, verifiedInDateSql } from "../src/server/contractor-standing-sql";
import { addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

const NOW = "2026-11-21T01:00:00.000Z";
const TODAY = "2026-11-21";
const PDF = Uint8Array.from([...Buffer.from("%PDF-1.4\n"), 1, 2, 3]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const details = (insuranceExpiry: string, licenceExpiry: string | null = null) => ({ businessName: "Bright Sparks", abn: "51824753556", licenceNumber: licenceExpiry ? "L-1" : null, licenceAuthority: licenceExpiry ? "QBCC" : null, licenceExpiry, insurer: "Allianz", policyNumber: "PL-1", insuranceExpiry });

function ports(o: { scan?: "clean" | "infected" | "throw"; configured?: boolean } = {}) {
  const store = new Map<string, Uint8Array>();
  const storage: ObjectStoragePort = { configured: o.configured ?? true, async put(k, b) { store.set(k, b); }, async get(k) { const b = store.get(k); if (!b) throw new Error("missing"); return b; } };
  const scanner: MalwareScanPort = { configured: o.configured ?? true, async scan() { if (o.scan === "throw") throw new Error("down"); return o.scan ?? "clean"; } };
  return { store, storage, scanner };
}

describe.skipIf(!DATABASE_URL)("contractor certificates (Postgres)", () => {
  let t: TestDb;
  let db: TestDb["db"];
  beforeAll(async () => { t = await createTestDb(); db = t.db; }, 60_000);
  afterAll(async () => { await t?.close(); });

  const verified = async (ins: string, lic: string | null = null) => {
    const staff = await addUser(db, "admin");
    const c = await addUser(db, "agent");
    await submitVerificationPg(db, c, details(ins, lic));
    await decideVerificationPg(db, c, staff, "verify", null);
    return c;
  };
  const eligible = async (c: string) => (await db.query(`SELECT 1 FROM app_user u WHERE u.id = $1::uuid AND ${notSuspendedSql("u.id")} AND ${verifiedInDateSql("u.id")}`, [c])).rows.length === 1;
  const notices = async (c: string) => (await db.query("SELECT kind, milestone FROM contractor_expiry_notice WHERE user_id = $1::uuid ORDER BY kind, milestone DESC", [c])).rows.map(r => `${r["kind"]}:${r["milestone"]}`);
  const inbox = async (c: string) => (await db.query("SELECT kind, title FROM notification WHERE user_id = $1::uuid AND kind LIKE 'cert_%' ORDER BY created_at", [c])).rows.map(r => `${r["kind"]}`);

  it("uploads store a random key, sniff the real type, supersede the older file and never delete", async () => {
    const c = await addUser(db, "agent");
    const p = ports();
    const d = { db, storage: p.storage, scanner: p.scanner, now: () => NOW };
    const a = await uploadCertificate(d, c, "insurance", "2027-03-01", PDF, "application/pdf");
    expect(a.ok).toBe(true);
    const b = await uploadCertificate(d, c, "insurance", "2028-03-01", PNG, "image/png");
    expect(b.ok).toBe(true);
    await uploadCertificate(d, c, "licence", "2027-06-01", PDF, "application/pdf");
    const cur = await listCertificatesPg(db, c);
    expect(cur.map(x => `${x.kind}:${x.expiry}`)).toEqual(["insurance:2028-03-01", "licence:2027-06-01"]);
    expect(Object.keys(cur[0]!)).not.toContain("storageKey");
    const all = (await db.query("SELECT status, storage_key FROM contractor_certificate WHERE user_id = $1::uuid ORDER BY uploaded_at", [c])).rows;
    expect(all.map(r => r["status"])).toEqual(["superseded", "active", "active"]);
    expect(all.every(r => /^cert\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(String(r["storage_key"])))).toBe(true);
    expect(p.store.size).toBe(3);
  });

  it("refuses wrong or mismatched types, big files, infected files, a down scanner and unconfigured providers", async () => {
    const c = await addUser(db, "agent");
    const run = (o: Parameters<typeof ports>[0], bytes: Uint8Array, mime: string) => { const p = ports(o); return uploadCertificate({ db, storage: p.storage, scanner: p.scanner, now: () => NOW }, c, "insurance", "2027-03-01", bytes, mime); };
    expect(await run({}, Uint8Array.from([1, 2, 3]), "application/pdf")).toMatchObject({ ok: false, code: "invalid" });
    expect(await run({}, PNG, "application/pdf")).toMatchObject({ ok: false, code: "invalid" }); // real type must equal the declared one
    expect(await run({}, Uint8Array.from([...Buffer.from("<svg"), 0]), "image/svg+xml")).toMatchObject({ ok: false, code: "invalid" });
    expect(await run({}, new Uint8Array(0), "application/pdf")).toMatchObject({ ok: false, code: "invalid" });
    expect(await run({}, Uint8Array.from([...PDF, ...new Uint8Array(10_000_001)]), "application/pdf")).toMatchObject({ ok: false, code: "invalid" });
    expect(await run({ scan: "infected" }, PDF, "application/pdf")).toMatchObject({ ok: false, code: "invalid" });
    expect(await run({ scan: "throw" }, PDF, "application/pdf")).toMatchObject({ ok: false, code: "unavailable" });
    expect(await run({ configured: false }, PDF, "application/pdf")).toMatchObject({ ok: false, code: "unavailable" });
    expect(await listCertificatesPg(db, c)).toEqual([]);
  });

  it("only active contractor accounts can upload, and there is a daily limit", async () => {
    const owner = await addUser(db, "owner");
    const suspended = await addUser(db, "agent", "suspended");
    const p = ports();
    const d = { db, storage: p.storage, scanner: p.scanner, now: () => NOW };
    expect(await uploadCertificate(d, owner, "insurance", "2027-03-01", PDF, "application/pdf")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await uploadCertificate(d, suspended, "insurance", "2027-03-01", PDF, "application/pdf")).toMatchObject({ ok: false, code: "forbidden" });
    const c = await addUser(db, "agent");
    for (let i = 0; i < 10; i++) expect((await uploadCertificate(d, c, "licence", "2027-03-01", PDF, "application/pdf")).ok).toBe(true);
    expect(await uploadCertificate(d, c, "licence", "2027-03-01", PDF, "application/pdf")).toMatchObject({ ok: false, code: "rate_limited" });
  });

  it("a file is served to its owner (or staff, who pass null) and to nobody else", async () => {
    const a = await addUser(db, "agent"), b = await addUser(db, "agent");
    const id = (await addCertificatePg(db, { userId: a, kind: "insurance", storageKey: `cert/${a}/k1`, sha256: "a".repeat(64), mime: "application/pdf", sizeBytes: 5, expiry: "2027-03-01" }))!;
    expect(await certificateFilePg(db, id, a)).toMatchObject({ storageKey: `cert/${a}/k1`, contentType: "application/pdf" });
    expect(await certificateFilePg(db, id, b)).toBeUndefined();
    expect(await certificateFilePg(db, id, null)).toBeDefined();
  });

  it("a certificate past its own date removes the badge and Elena eligibility, though the typed date is still ahead", async () => {
    const c = await verified("2027-06-01");
    expect(await eligible(c)).toBe(true);
    // A file whose date has passed (inserted directly: the upload route refuses expired dates).
    await db.query("INSERT INTO contractor_certificate (user_id, kind, storage_key, sha256, declared_mime, size_bytes, expiry_date) VALUES ($1::uuid,'insurance',$2,$3,'application/pdf',5,'2026-11-01')", [c, `cert/${c}/old`, "b".repeat(64)]);
    expect(await eligible(c)).toBe(false);
    expect((await publicTrustPg(db, c, TODAY))!.badge).toBe(false);
    const row = (await listVerificationsPg(db, "all", TODAY)).find(v => v.userId === c)!;
    expect(row.state).toMatchObject({ badge: false, insuranceExpired: true });
    // Replacing it with a current file brings both back with no staff action.
    await addCertificatePg(db, { userId: c, kind: "insurance", storageKey: `cert/${c}/new`, sha256: "c".repeat(64), mime: "application/pdf", sizeBytes: 5, expiry: "2027-06-01" });
    expect(await eligible(c)).toBe(true);
    expect((await publicTrustPg(db, c, TODAY))!.badge).toBe(true);
    expect((await currentCertificatesPg(db, [c])).get(c)).toHaveLength(1);
  });

  it("expiry dates that pass remove the badge and eligibility on their own", async () => {
    const c = await verified("2026-11-20");
    expect(await eligible(c)).toBe(false);
    expect((await publicTrustPg(db, c, TODAY))!.badge).toBe(false);
  });

  it("emails at 30 days, 7 days and expiry, once each, even when the job runs every tick", async () => {
    const c = await verified("2026-12-15", "2027-06-01"); // insurance 24 days out, licence far away
    const run = async (now: string) => { await runCertificateExpiryNotices(db, now); return (await inbox(c)).length; };
    expect(await run(NOW)).toBe(1);
    expect(await run(NOW)).toBe(1);
    expect(await run("2026-11-21T09:00:00.000Z")).toBe(1);
    expect(await notices(c)).toEqual(["insurance:30"]);
    expect(await run("2026-12-09T01:00:00.000Z")).toBe(2); // 6 days left
    expect(await run("2026-12-10T01:00:00.000Z")).toBe(2);
    expect(await run("2026-12-15T23:00:00.000Z")).toBe(2); // the date itself is still in date
    expect(await run("2026-12-16T01:00:00.000Z")).toBe(3); // expired
    expect(await run("2026-12-30T01:00:00.000Z")).toBe(3);
    expect(await notices(c)).toEqual(["insurance:30", "insurance:7", "insurance:0"]);
    expect(await inbox(c)).toEqual(["cert_expiring", "cert_expiring", "cert_expired"]);
  });

  it("a missed stretch sends only the step that applies now; a renewal with a new date starts the schedule again", async () => {
    const c = await verified("2026-11-24"); // 3 days left on the first run: straight to the 7-day step
    await runCertificateExpiryNotices(db, NOW);
    expect(await notices(c)).toEqual(["insurance:7"]);
    const staff = await addUser(db, "admin");
    await submitVerificationPg(db, c, details("2027-02-01"));
    await runCertificateExpiryNotices(db, NOW); // pending again: no reminders until staff verify
    expect(await notices(c)).toEqual(["insurance:7"]);
    await decideVerificationPg(db, c, staff, "verify", null);
    await runCertificateExpiryNotices(db, "2027-01-10T01:00:00.000Z");
    expect(await notices(c)).toEqual(["insurance:30", "insurance:7"]);
  });

  it("licence dates are reminded separately; unverified, rejected and suspended contractors get nothing", async () => {
    const lic = await verified("2027-12-01", "2026-12-01");
    const pending = await addUser(db, "agent");
    await submitVerificationPg(db, pending, details("2026-11-25"));
    const staff = await addUser(db, "admin");
    const rejected = await addUser(db, "agent");
    await submitVerificationPg(db, rejected, details("2026-11-25"));
    await decideVerificationPg(db, rejected, staff, "reject", "No.");
    const susp = await verified("2026-11-25");
    await setSuspensionPg(db, staff, susp, true, "Reported.");
    await runCertificateExpiryNotices(db, NOW);
    expect(await notices(lic)).toEqual(["licence:30"]);
    expect(await notices(pending)).toEqual([]);
    expect(await notices(rejected)).toEqual([]);
    expect(await notices(susp)).toEqual([]);
  });
});
