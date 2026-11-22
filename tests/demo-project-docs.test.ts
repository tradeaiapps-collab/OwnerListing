import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error plain Node script (no types), shared with scripts/seed-demo.mjs
import { demoDocLines, makeDemoPdf, seedProjectDocuments } from "../scripts/demo-project-docs.mjs";
import { sniffMime } from "../src/domain/file-sniff";
import { resolveStorageKey } from "../src/adapters/local-disk-core.mjs";
import { createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

describe("demo project PDF", () => {
  it("is a real PDF with a correct cross-reference table and the document text", () => {
    const bytes: Buffer = makeDemoPdf("Feasibility study (demo)", demoDocLines("feasibility", { title: "Riverside", location: "Bulimba", jurisdiction: "QLD" }));
    expect(sniffMime(bytes)).toBe("application/pdf");
    const text = bytes.toString("latin1");
    expect(text.endsWith("%%EOF\n")).toBe(true);
    const start = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(start, start + 4)).toBe("xref");
    const entries = [...text.slice(start).matchAll(/(\d{10}) 00000 n /g)].map(m => Number(m[1]));
    entries.forEach((off, i) => expect(text.slice(off).startsWith(`${i + 1} 0 obj`)).toBe(true));
    expect(text).toContain("Feasibility study");
  });
  it("wraps long text onto more pages", () => {
    const lines = Array.from({ length: 120 }, (_, i) => `Line ${i} with some words to fill the page`);
    expect((makeDemoPdf("Long", lines).toString("latin1").match(/\/Type \/Page /g) ?? []).length).toBeGreaterThan(2);
  });
});

describe.skipIf(!DATABASE_URL)("seedProjectDocuments on Postgres", () => {
  let t: TestDb; let dir: string; let projectId: string;
  beforeAll(async () => {
    t = await createTestDb();
    dir = await mkdtemp(path.join(os.tmpdir(), "demo-docs-"));
    process.env["LOCAL_STORAGE_DIR"] = dir;
    const owner = String((await t.db.query("INSERT INTO app_user (email, display_name, user_type, status) VALUES ('olivia@demo.invalid','Olivia','owner','active') RETURNING id")).rows[0]!["id"]);
    projectId = String((await t.db.query(
      `INSERT INTO investment_project (owner_user_id, title, location, jurisdiction, project_type, summary, stage, funding_target_cents, minimum_ticket_cents, timeline, risks, structure_description,
         visible_to, issuer_name, issuer_licence_basis, issuer_statement, issuer_authorised_confirmed, status, posting_model, commission_type, commission_bps, commission_fixed_cents, upfront_fee_cents, upfront_fee_status, model2_disclosure)
       VALUES ($1,'Riverside Terraces','Bulimba QLD','QLD','residential_development','Twelve townhouses on a riverside site.','approved',240000000,5000000,'14 months','Cost and sales risk.','Unit trust.','wholesale_only','Riverside Pty Ltd','s708','',true,'approved','commission_on_contract','percent',400,0,0,'not_required','off') RETURNING id`, [owner])).rows[0]!["id"]);
  }, 60_000);
  afterAll(async () => { await t?.close(); if (dir) await rm(dir, { recursive: true, force: true }); });

  it("adds documents with real files to a project that has none, and does it only once", async () => {
    const pool = await t.pool.connect();
    try {
      await seedProjectDocuments(pool);
      const rows = (await pool.query("SELECT storage_key, size_bytes, sha256 FROM investment_project_document WHERE project_id = $1", [projectId])).rows;
      expect(rows.length).toBe(5);
      for (const r of rows) {
        const bytes = await readFile(resolveStorageKey(dir, String(r["storage_key"])));
        expect(bytes.length).toBe(Number(r["size_bytes"]));
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(String(r["sha256"]));
      }
      await seedProjectDocuments(pool);
      expect((await pool.query("SELECT 1 FROM investment_project_document WHERE project_id = $1", [projectId])).rows.length).toBe(5);
    } finally { pool.release(); }
  });
});
