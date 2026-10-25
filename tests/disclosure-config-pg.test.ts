import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activeListingDocumentPg, approveVersionPg, approvedVersionPg, createDraftVersionPg, disclosureRequirementsPg, listingDisclosuresPg,
  listVersionsPg, reviewDisclosurePg, reviewQueuePg, submitDisclosurePg
} from "../src/server/disclosure-config-db";
import { createPgListingRepository } from "../src/server/db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

describe.skipIf(!DATABASE_URL)("state disclosures (Postgres)", () => {
  let t: TestDb;
  let db: TestDb["db"];
  beforeAll(async () => { t = await createTestDb(); db = t.db; }, 60_000);
  afterAll(async () => { await t?.close(); });

  const item = { key: "qld_seller_disclosure_statement", label: "Seller disclosure statement", description: "The signed seller disclosure statement.", legalRef: "Property Law Act 2023 (Qld)", notApplicableAllowed: false };

  it("seeds the four Queensland combinations as drafts, so nothing in QLD can publish yet", async () => {
    const qld = (await listVersionsPg(db)).filter(v => v.jurisdiction === "QLD");
    expect(qld.map(v => [v.transactionType, v.useClass, v.version, v.status, v.createdBy]).sort()).toEqual([
      ["rent", "commercial", 1, "draft", null], ["rent", "residential", 1, "draft", null], ["sale", "commercial", 1, "draft", null], ["sale", "residential", 1, "draft", null]
    ]);
    expect(await approvedVersionPg(db, "QLD", "sale", "residential")).toBeNull();
  });

  it("drafts the next version, refuses the author's own approval, approves, and retires the previous approved version", async () => {
    const a = await addUser(db, "admin"), b = await addUser(db, "admin");
    const seed = (await listVersionsPg(db)).find(v => v.jurisdiction === "QLD" && v.transactionType === "sale" && v.useClass === "residential")!;
    expect(await approveVersionPg(db, seed.id, a, "Counsel confirmed the QLD list.")).toEqual({ ok: true, retiredId: null });
    const d = await createDraftVersionPg(db, { jurisdiction: "QLD", transactionType: "sale", useClass: "residential", items: [item], note: "Trimmed after counsel review." }, a);
    expect(d).toMatchObject({ ok: true, version: 2 });
    if (!d.ok) throw new Error("draft failed");
    expect(await approveVersionPg(db, d.id, a, "My own draft, approving it.")).toMatchObject({ ok: false, status: 403 });
    expect(await approveVersionPg(db, d.id, b, "Second person check done.")).toEqual({ ok: true, retiredId: seed.id });
    expect(await approveVersionPg(db, d.id, b, "Second person check done.")).toMatchObject({ ok: false, status: 409 });
    const live = await approvedVersionPg(db, "QLD", "sale", "residential");
    expect([live?.id, live?.version, live?.items.map(i => i.key)]).toEqual([d.id, 2, ["qld_seller_disclosure_statement"]]);
    const all = (await listVersionsPg(db)).filter(v => v.jurisdiction === "QLD" && v.transactionType === "sale" && v.useClass === "residential");
    expect(all.map(v => [v.version, v.status])).toEqual([[2, "approved"], [1, "retired"]]);
  });

  it("protects versions: approved items are fixed, retired stays retired, nothing is deleted, one approved per combination", async () => {
    const live = (await approvedVersionPg(db, "QLD", "sale", "residential"))!;
    await expect(db.query("UPDATE disclosure_config_version SET items = '[]' WHERE id = $1", [live.id])).rejects.toThrow(/cannot be changed/);
    await expect(db.query("DELETE FROM disclosure_config_version WHERE id = $1", [live.id])).rejects.toThrow(/permanent/);
    const retired = (await listVersionsPg(db)).find(v => v.status === "retired")!;
    await expect(db.query("UPDATE disclosure_config_version SET status = 'approved', retired_at = NULL WHERE id = $1", [retired.id])).rejects.toThrow(/reinstated/);
    const u = await addUser(db, "admin");
    await expect(db.query(
      `INSERT INTO disclosure_config_version (jurisdiction, transaction_type, use_class, version, items, status, note, created_by, approved_by, approved_at)
       VALUES ('QLD','sale','residential', 99, '[]', 'approved', 'Sneaky second approved.', NULL, $1, now())`, [u]
    )).rejects.toThrow(/disclosure_config_one_approved/);
  });

  it("owner submits, Compliance verifies, the listing record sees it as satisfied; the owner cannot review their own", async () => {
    const owner = await addUser(db, "owner"), staff = await addUser(db, "admin");
    const listingId = await addListing(db, owner, { jurisdiction: "QLD" });
    const live = (await approvedVersionPg(db, "QLD", "sale", "residential"))!;
    const rec = (await createPgListingRepository(db).get(listingId))!;
    expect(await disclosureRequirementsPg(db, rec.listing)).toEqual({ versionId: live.id, keys: ["qld_seller_disclosure_statement"] });

    const propertyId = (await db.query("INSERT INTO property (address_text, state) VALUES ('1 Test St','QLD') RETURNING id")).rows[0]!["id"];
    const docId = (await db.query(
      `INSERT INTO property_document (property_id, listing_id, kind, storage_key, sha256, uploaded_by, source, declared_mime, size_bytes)
       VALUES ($1, $2, 'contract', $3, $4, $5, 'owner_supplied', 'application/pdf', 100) RETURNING id`,
      [propertyId, listingId, `k-${randomUUID()}`, "a".repeat(64), owner]
    )).rows[0]!["id"] as string;
    expect(await activeListingDocumentPg(db, listingId, docId)).toBe(true);
    expect(await activeListingDocumentPg(db, randomUUID(), docId)).toBe(false);

    await submitDisclosurePg(db, { listingId, jurisdiction: "QLD", key: "qld_seller_disclosure_statement", versionId: live.id, actorId: owner, input: { kind: "evidence", documentId: docId } });
    const [row] = await listingDisclosuresPg(db, listingId);
    expect(row).toMatchObject({ key: "qld_seller_disclosure_statement", state: "submitted", satisfied: false, evidenceDocumentId: docId });
    const q = (await reviewQueuePg(db)).find(x => x.listingId === listingId)!;
    expect(q.item?.label).toBe("Seller disclosure statement");
    expect(q.evidenceKind).toBe("contract");

    expect((await reviewDisclosurePg(db, q.id, owner, "verify", "Looks fine to me, verified.")).outcome).toBe("own_listing");
    expect((await reviewDisclosurePg(db, q.id, staff, "verify", "Form 2 signed, certificates attached.")).outcome).toBe("reviewed");
    expect((await reviewDisclosurePg(db, q.id, staff, "reject", "Changed my mind about it.")).outcome).toBe("already_reviewed");
    const after = (await createPgListingRepository(db).get(listingId))!;
    expect(after.listing.disclosures).toEqual([{ key: "qld_seller_disclosure_statement", jurisdiction: "QLD", satisfied: true, evidenceReference: docId }]);

    // A new submission resets the decision: the item stops counting until reviewed again.
    await submitDisclosurePg(db, { listingId, jurisdiction: "QLD", key: "qld_seller_disclosure_statement", versionId: live.id, actorId: owner, input: { kind: "evidence", documentId: docId } });
    expect((await listingDisclosuresPg(db, listingId))[0]).toMatchObject({ state: "submitted", satisfied: false, reviewReason: null });
  });

  it("enforces satisfied only when verified, at the database", async () => {
    const owner = await addUser(db, "owner");
    const listingId = await addListing(db, owner, { jurisdiction: "QLD" });
    await expect(db.query(
      "INSERT INTO listing_disclosure (listing_id, jurisdiction, disclosure_key, satisfied, not_applicable, submitted_by) VALUES ($1, 'QLD', 'x_key', true, true, $2)", [listingId, owner]
    )).rejects.toThrow(/listing_disclosure_satisfied_state/);
  });
});
