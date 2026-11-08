// LOCAL TEST KIT: real, small PDF files for the demo investor projects, so the "Project documents" card lists files that open and download.
// Called from scripts/seed-demo.mjs. Idempotent: adds documents to projects that have none, and writes the file bytes for any
// document row whose file is missing (the older admin seed created rows without files). Demo data only, never run in production.
import { createHash, randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { localDevStorageDir, putLocalObject, resolveStorageKey } from "../src/adapters/local-disk-core.mjs";

const esc = s => s.replace(/[\\()]/g, m => "\\" + m);
const ascii = s => s.replace(/[^\x20-\x7e]/g, "-");

/** A valid one-page-per-section PDF (Helvetica, A4) with a title, wrapped body lines and a demo footer. */
export function makeDemoPdf(title, lines) {
  const pages = [];
  let cur = [];
  const wrap = [];
  for (const line of lines) {
    const words = ascii(line).split(" ");
    let out = "";
    for (const w of words) { if ((out + " " + w).trim().length > 88) { wrap.push(out); out = w; } else out = (out + " " + w).trim(); }
    wrap.push(out);
  }
  for (const l of wrap) { cur.push(l); if (cur.length >= 42) { pages.push(cur); cur = []; } }
  if (cur.length || !pages.length) pages.push(cur);

  const objs = []; // 1 catalog, 2 pages, 3 font, 4 bold font, then page/content pairs
  const pageIds = pages.map((_, i) => 5 + i * 2);
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map(i => `${i} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  objs[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>";
  pages.forEach((ls, i) => {
    const body = [
      "BT /F2 18 Tf 56 780 Td (" + esc(ascii(title)) + ") Tj ET",
      "BT /F1 9 Tf 56 36 Td (DEMO DATA for local testing - not a real offer or document. Page " + (i + 1) + " of " + pages.length + ") Tj ET",
      "BT /F1 11 Tf 14 TL 56 748 Td " + ls.map(l => "(" + esc(l) + ") Tj T*").join(" ") + " ET"
    ].join("\n");
    objs[5 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`;
    objs[6 + i * 2] = `<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`;
  });
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (let n = 1; n < objs.length; n++) { offsets[n] = Buffer.byteLength(pdf); pdf += `${n} 0 obj\n${objs[n]}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objs.length}\n0000000000 65535 f \n` + offsets.slice(1).map(o => String(o).padStart(10, "0") + " 00000 n \n").join("");
  pdf += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

/** Body text for one kind of document about one project. */
export function demoDocLines(kind, p) {
  const where = `${p.location}, ${p.jurisdiction}`;
  const head = [`Project: ${p.title}`, `Location: ${where}`, `Issuer: ${p.issuer_name ?? "Issuer (demo)"}`, ""];
  const body = {
    plan: ["SITE AND FLOOR PLANS", "Site area, lot layout and typical floor plans for the development.", "", "Site plan: lots arranged around a central driveway with street frontage, landscaped setbacks and visitor parking.",
      "Typical floor plan: ground floor living, kitchen and garage; first floor bedrooms and bathrooms; private courtyard.", "Scale 1:200 at A3. Dimensions to be confirmed by the surveyor before construction."],
    approval: ["DEVELOPMENT APPROVAL (SUMMARY)", "Council has approved the development application, subject to the conditions below.", "",
      "1. Development to proceed in accordance with the approved plans.", "2. Landscaping and stormwater works completed before occupancy.", "3. Construction hours limited to 7am-6pm Monday to Saturday.",
      "4. Infrastructure charges payable before the plan is sealed.", "Approval period: four years from the date of decision."],
    feasibility: ["FEASIBILITY STUDY", "Summary of assumptions and the expected outcome. Figures are illustrative only.", "",
      "Total development cost: land, construction, holding costs and contingency.", "Funding: senior bank loan plus equity raised from investors.", "Sales: forecast end value based on comparable sales in the area.",
      "Sensitivity: a 10 percent fall in sale prices or a 10 percent rise in construction cost reduces the projected return.", "No return is promised. Investors can lose some or all of their capital."],
    contract: ["DRAFT SUBSCRIPTION AGREEMENT", "Draft terms between the issuer and an investor. Not for signing.", "",
      "1. The investor subscribes for units in the trust for the amount agreed.", "2. Funds are paid to the issuer's trust account, never to OwnerListing.", "3. Units rank behind the senior lender.",
      "4. Distributions are made only after practical completion and settlement of sales.", "5. This agreement is signed off the platform. Seek your own legal and financial advice."],
    report: ["QUARTERLY PROGRESS REPORT", "Progress against the programme for the latest quarter.", "",
      "Site works: earthworks and services complete; slabs poured on schedule.", "Budget: spending within the approved budget; contingency not drawn.", "Programme: on track for practical completion as per the project timeline.",
      "Risks: weather delays and supplier lead times are being monitored."],
    other: ["PROJECT DOCUMENT", "Supporting information for investors."]
  }[kind] ?? ["PROJECT DOCUMENT"];
  return [...head, ...body];
}

const DEFAULT_DOCS = [["plan", "Site and floor plans", "investors"], ["approval", "Development approval", "investors"], ["feasibility", "Feasibility study", "investors"],
  ["contract", "Draft subscription agreement", "private"], ["report", "Quarterly progress report", "investors"]];
const exists = p => access(p).then(() => true, () => false);
const sha256 = b => createHash("sha256").update(b).digest("hex");

export async function seedProjectDocuments(db) {
  const dir = localDevStorageDir(process.env);
  if (!dir) { console.log("Demo project documents skipped: LOCAL_STORAGE_DIR is not set (run local-setup again to add it)."); return; }
  const q = async (text, params) => (await db.query(text, params)).rows;
  let added = 0, filled = 0;
  await db.query("BEGIN");
  try {
    // 1. Demo projects (owned by a demo account, not rejected) that have no documents at all.
    const empty = await q(`SELECT p.id, p.owner_user_id, p.title, p.location, p.jurisdiction, p.issuer_name FROM investment_project p JOIN app_user u ON u.id = p.owner_user_id
      WHERE u.email LIKE '%@demo.invalid' AND p.status <> 'rejected' AND NOT EXISTS (SELECT 1 FROM investment_project_document d WHERE d.project_id = p.id) ORDER BY p.created_at`);
    for (const p of empty) {
      for (const [kind, title, visibility] of DEFAULT_DOCS) {
        const id = randomUUID(), key = `investments/${p.id}/${randomUUID()}`, bytes = makeDemoPdf(`${title} - ${p.title}`, demoDocLines(kind, p));
        await putLocalObject(dir, key, bytes);
        await q(`INSERT INTO investment_project_document (id, project_id, kind, visibility, title, uploaded_by, content_type, size_bytes, sha256, storage_key)
                 VALUES ($1, $2, $3, $4, $5, $6, 'application/pdf', $7, $8, $9)`, [id, p.id, kind, visibility, title, p.owner_user_id, bytes.length, sha256(bytes), key]);
        added++;
      }
    }
    // 2. Document rows of demo projects whose file is missing (rows made by an older seed): write the PDF and correct size and fingerprint.
    //    The table is insert-only, so the guard trigger is switched off for this local-only fix and back on in the same transaction.
    const missing = [];
    for (const d of await q(`SELECT d.id, d.kind, d.title, d.storage_key, p.title AS ptitle, p.location, p.jurisdiction, p.issuer_name FROM investment_project_document d
      JOIN investment_project p ON p.id = d.project_id JOIN app_user u ON u.id = p.owner_user_id WHERE u.email LIKE '%@demo.invalid' ORDER BY d.uploaded_at`)) {
      if (!(await exists(resolveStorageKey(dir, d.storage_key)))) missing.push(d);
    }
    if (missing.length) {
      await q("ALTER TABLE investment_project_document DISABLE TRIGGER investment_project_document_append_only");
      for (const d of missing) {
        const bytes = makeDemoPdf(`${d.title} - ${d.ptitle}`, demoDocLines(d.kind, { title: d.ptitle, location: d.location, jurisdiction: d.jurisdiction, issuer_name: d.issuer_name }));
        await putLocalObject(dir, d.storage_key, bytes);
        await q("UPDATE investment_project_document SET size_bytes = $2, sha256 = $3 WHERE id = $1", [d.id, bytes.length, sha256(bytes)]);
        filled++;
      }
      await q("ALTER TABLE investment_project_document ENABLE TRIGGER investment_project_document_append_only");
    }
    await db.query("COMMIT");
  } catch (e) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw e;
  }
  console.log(added || filled ? `Demo project documents: ${added} added to projects with none, ${filled} existing rows given a real PDF.` : "Demo project documents already present.");
}
