// Demo data for the LOCAL TEST KIT (docs/LOCAL_TEST.md). Idempotent: does nothing if the demo accounts already exist, except
// filling in later additions (real photos, descriptions, the demo investor project) on a database seeded by an older version.
// Refuses to run unless NODE_ENV is not "production" AND DATABASE_URL points at localhost / 127.0.0.1. Usage: npm run seed:demo
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import pg from "pg";
import { localDevStorageDir, putLocalObject } from "../src/adapters/local-disk-core.mjs";
import { seedAdminExamples } from "./seed-admin-demo.mjs";
import { seedProjectDocuments } from "./demo-project-docs.mjs";

// ---- Demo photos (local test kit) --------------------------------------------------------------------------------
// Small generated PNG pictures (no camera, so no metadata) written through the same local-disk storage code the app
// uses. Only when LOCAL_STORAGE_DIR passes the dev-only guard. Listings that already have a gallery are left alone.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function pngChunk(type, data) {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
/** RGB PNG from a pixel function (x, y) => [r, g, b]. */
function makePng(w, h, px) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) { const [r, g, b] = px(x, y); raw[row + 1 + x * 3] = r; raw[row + 2 + x * 3] = g; raw[row + 3 + x * 3] = b; }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw, { level: 6 })), pngChunk("IEND", Buffer.alloc(0))]);
}
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const W = 960, H = 640;
const PALETTES = [[[226, 114, 91], [244, 236, 220]], [[86, 130, 163], [236, 240, 244]], [[120, 150, 110], [242, 240, 232]], [[180, 140, 90], [246, 242, 236]]];

/** Front of a house: sky, lawn, walls, roof, door and windows. */
function exterior(p) {
  const [accent, wall] = PALETTES[p % PALETTES.length];
  return makePng(W, H, (x, y) => {
    const roofTop = 150, eave = 270, base = 520, left = 250, right = 710, mid = 480;
    const inRoof = y >= roofTop && y < eave && Math.abs(x - mid) <= ((y - roofTop) / (eave - roofTop)) * (right - left + 60) / 2;
    if (inRoof) return mix(accent, [40, 40, 40], 0.35);
    if (x >= left && x <= right && y >= eave && y < base) {
      if (x >= 450 && x <= 510 && y >= 400) return mix(accent, [30, 30, 30], 0.5);
      if (((x >= 290 && x <= 390) || (x >= 570 && x <= 670)) && y >= 320 && y <= 410) return [170, 205, 230];
      return wall;
    }
    if (y >= base - 20) return mix([96, 150, 78], [70, 120, 60], (y - base + 20) / (H - base + 20));
    return mix([150, 200, 240], [225, 238, 250], y / base);
  });
}
/** A room: wall, floor, a window with daylight and a sofa or bench block. */
function interior(p, k) {
  const [accent, wall] = PALETTES[(p + k) % PALETTES.length];
  return makePng(W, H, (x, y) => {
    if (y > 440) return mix([168, 128, 92], [128, 92, 64], (y - 440) / (H - 440));
    if (x >= 560 && x <= 820 && y >= 110 && y <= 360) return (x - 560) % 130 < 6 || (y - 110) % 125 < 6 ? [235, 235, 235] : mix([190, 220, 245], [245, 250, 255], (y - 110) / 250);
    if (x >= 120 + k * 30 && x <= 460 + k * 30 && y >= 340 && y <= 450) return mix(accent, [60, 60, 60], 0.15);
    return mix(wall, [255, 255, 255], 0.2 + (x / W) * 0.2);
  });
}
/** Floor plan: white page, dark walls drawn as room rectangles. */
function floorplan() {
  const rooms = [[80, 80, 460, 340], [460, 80, 880, 340], [80, 340, 340, 560], [340, 340, 640, 560], [640, 340, 880, 560]];
  return makePng(W, H, (x, y) => {
    for (const [a, b, c, d] of rooms) {
      const onV = (Math.abs(x - a) < 4 || Math.abs(x - c) < 4) && y >= b && y <= d;
      const onH = (Math.abs(y - b) < 4 || Math.abs(y - d) < 4) && x >= a && x <= c;
      if (onV || onH) return [34, 40, 49];
    }
    return [252, 252, 250];
  });
}

/** Labelled floor plan and a short walkthrough video (scripts/demo-media), so the gallery shows both kinds. */
const MEDIA_DIR = new URL("./demo-media/", import.meta.url);
const floorplanImage = () => readFileSync(new URL("floorplan.png", MEDIA_DIR));

const CAPTIONS = ["Street view", "Living room", "Kitchen and dining", "Main bedroom", "Backyard"];

// Real photos (scripts/demo-photos, Unsplash License, fetched by scripts/fetch-demo-photos.mjs). Used when the files are there;
// otherwise the generated pictures above. Camera metadata is stripped here, as the upload pipeline would.
const PHOTO_DIR = fileURLToPath(new URL("./demo-photos/", import.meta.url));
const manifest = await readFile(PHOTO_DIR + "manifest.json", "utf8").then(JSON.parse, () => ({ listings: [], project: { photos: [] } }));

/** Removes APP1-APP15 and comment segments; returns the stripped bytes and the frame size, or null if this is not a baseline/progressive JPEG. */
function stripJpeg(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const keep = [buf.subarray(0, 2)];
  let i = 2, width = 0, height = 0;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xda) { keep.push(buf.subarray(i)); break; } // start of scan: the rest is image data
    const len = buf.readUInt16BE(i + 2);
    if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) { height = buf.readUInt16BE(i + 5); width = buf.readUInt16BE(i + 7); }
    if (!((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe)) keep.push(buf.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  return width && height ? { bytes: Buffer.concat(keep), width, height } : null;
}
/** The real photos available for a manifest entry list, in order; files that are missing or unreadable are skipped. */
async function realPhotos(entries) {
  const out = [];
  for (const e of entries ?? []) {
    const j = stripJpeg(await readFile(PHOTO_DIR + e.file).catch(() => Buffer.alloc(0)));
    if (j) out.push({ ...j, contentType: "image/jpeg", kind: "photo", caption: e.caption, alt: e.alt ?? "" });
  }
  return out;
}
const pngPic = (bytes, kind, caption) => ({ bytes, width: W, height: H, contentType: "image/png", kind, caption, alt: "" });

async function storePhotos(client, dir, table, parentCol, parentId, uploader, pictures) {
  const entries = [];
  for (const pic of pictures) {
    const id = randomUUID(), key = `${table === "listing_photo" ? "listings" : "investments"}/${parentId}/${randomUUID()}`;
    await putLocalObject(dir, key, pic.bytes);
    const kindCol = table === "listing_photo" ? ", kind" : "", kindVal = table === "listing_photo" ? ", $10" : "";
    await client.query(
      `INSERT INTO ${table} (id, ${parentCol}, uploaded_by, content_type, width, height, size_bytes, sha256, storage_key${kindCol})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9${kindVal})`,
      [id, parentId, uploader, pic.contentType, pic.width, pic.height, pic.bytes.length, createHash("sha256").update(pic.bytes).digest("hex"), key, ...(kindCol ? [pic.kind] : [])]);
    entries.push({ photoId: id, caption: pic.caption, alt: pic.alt, hidden: false });
  }
  return entries;
}

async function seedPhotos(client) {
  const dir = localDevStorageDir(process.env);
  if (!dir) { console.log("Demo photos skipped: LOCAL_STORAGE_DIR is not set (run local-setup again to add it)."); return; }
  // Demo listings with no gallery, or with only generated pictures (an older seed): those get the real photos when present.
  const rows = (await client.query(
    `SELECT l.id, l.owner_user_id, l.address_text, cur.version, cur.entries,
            EXISTS (SELECT 1 FROM listing_photo p WHERE p.listing_id = l.id AND p.content_type <> 'image/png') AS has_real
       FROM property_listing l JOIN app_user u ON u.id = l.owner_user_id
       LEFT JOIN LATERAL (SELECT version, entries FROM listing_photo_layout p WHERE p.listing_id = l.id ORDER BY version DESC LIMIT 1) cur ON true
      WHERE u.email LIKE '%@demo.invalid' ORDER BY l.created_at, l.id`)).rows;
  let made = 0, listings = 0;
  for (const [i, l] of rows.entries()) {
    if (l.has_real) continue;
    const real = await realPhotos(manifest.listings.find(m => m.address === l.address_text)?.photos);
    if (l.version && !real.length) continue;
    let entries;
    if (l.version) {
      // Keep the current floor plan entries; the generated photos stay stored (files are never deleted) but leave the gallery.
      const plans = (await client.query(`SELECT id FROM listing_photo WHERE listing_id = $1 AND kind = 'floorplan'`, [l.id])).rows.map(r => r.id);
      entries = [...await storePhotos(client, dir, "listing_photo", "listing_id", l.id, l.owner_user_id, real), ...l.entries.filter(e => plans.includes(e.photoId))];
    } else {
      const pictures = real.length ? real : [exterior(i), interior(i, 0), interior(i, 1), interior(i, 2), exterior(i + 1)].map((bytes, k) => pngPic(bytes, "photo", CAPTIONS[k]));
      entries = await storePhotos(client, dir, "listing_photo", "listing_id", l.id, l.owner_user_id, [...pictures, pngPic(floorplanImage(), "floorplan", "Floor plan")]);
    }
    await client.query(`INSERT INTO listing_photo_layout (listing_id, version, entries, changed_by) VALUES ($1, $2, $3::jsonb, $4)`, [l.id, (l.version ?? 0) + 1, JSON.stringify(entries), l.owner_user_id]);
    made += entries.length; listings++;
  }
  console.log(listings ? `Demo photos added: ${made} gallery images on ${listings} listings.` : "Demo photos already present.");
  if (!(await realPhotos(manifest.listings[0]?.photos)).length) console.log("  (Generated pictures only: run node scripts/fetch-demo-photos.mjs for real photos, then seed again.)");
}

// ---- Demo listing descriptions ------------------------------------------------------------------------------------
// Property facts only (the wording filter's rule: describe the property, never the people). Fills empty descriptions only.
const DESCRIPTIONS = {
  "12 Jacaranda St, Paddington QLD 4064": "Renovated timber home on a 607 m2 elevated block with district views. Four bedrooms upstairs, two bathrooms, an open-plan kitchen with stone island and butler's pantry, and a deep veranda that opens to a north-facing backyard with an in-ground saltwater pool. Ducted air conditioning, 6.6 kW solar, double lock-up garage. Short drive to Given Terrace cafes and the city.",
  "8/21 Moray St, New Farm QLD 4005": "Light-filled two-bedroom apartment on the third floor of a boutique block. Open living and dining flows to a covered balcony with river glimpses. Stone kitchen with gas cooking, built-in wardrobes in both bedrooms, internal laundry, one secure car space. Close to New Farm Park, the CityCat and James Street. Available now on a 12-month lease.",
  "45 Beach Rd, Bondi NSW 2026": "Restored Federation weatherboard cottage on a 380 m2 block, 600 m from Bondi Beach. High ceilings, timber floors and original fireplaces throughout. Three bedrooms, two bathrooms, a light kitchen opening to a private rear garden with a timber deck, and off-street parking for one car. Easy access to buses and Bondi Junction.",
  "3/17 Darley Rd, Randwick NSW 2031": "Modern three-bedroom townhouse in a group of five. Open-plan living with timber floors opens to a private paved courtyard. Gas kitchen with dishwasher, main bedroom with ensuite and balcony, second bathroom, internal laundry and a double garage. Close to Randwick Junction, the light rail and Centennial Park.",
  "28 Station St, Fitzroy North VIC 3068": "Victorian-era brick home on a tree-lined street. Three bedrooms with high ceilings and ornate cornices, an original fireplace in the front living room, and a rear kitchen with skylight and stone benches opening to a north-facing courtyard garden. Renovated bathroom with freestanding bath. Walk to Edinburgh Gardens, trams and Rushall station.",
  "6/102 Chapel St, Windsor VIC 3181": "Sunny two-bedroom unit on the first floor of a solid brick block. Galley kitchen with gas cooktop, renovated bathroom with walk-in shower, built-in wardrobes and split-system heating and cooling. One car space and shared laundry. Trams at the door, Windsor station and Prahran Market close by.",
  "9/4 Park Ave, Chermside QLD 4032": "Low-maintenance three-bedroom townhouse in a well-kept complex of twelve. Open living and dining opens to a fenced courtyard, white kitchen with breakfast bar, main bedroom with ensuite and walk-in robe, ceiling fans and air conditioning throughout, double garage. Across the road from parkland; Westfield Chermside and the busway are minutes away.",
  "14/50 Kent St, Sydney NSW 2000": "Compact studio on level 9 with city views. Living and sleeping area with built-in desk and storage, kitchenette with stainless appliances, modern bathroom, building pool and gym. Walk to Wynyard, Barangaroo and the CBD. Furnished option available."
};
async function seedDescriptions(client) {
  let n = 0;
  for (const [address, text] of Object.entries(DESCRIPTIONS)) {
    n += (await client.query(`UPDATE property_listing SET description = $2 WHERE address_text = $1 AND description IS NULL`, [address, text])).rowCount ?? 0;
  }
  if (n) console.log(`Demo descriptions added: ${n} listings.`);
}

// ---- Demo investor project ----------------------------------------------------------------------------------------
// One approved project by a project owner (an owner account), with photos, and the fully verified buyer as a wholesale
// investor who registered non-binding interest and messaged the owner. Added once; skipped if the project owner exists.
const DISCLOSURE_VERSION = "2026-10-25-draft-1"; // src/config/investment-disclosure.ts (a newer version just asks James to re-acknowledge)
async function seedProject(client) {
  const q = async (text, params) => (await client.query(text, params)).rows;
  if ((await q(`SELECT 1 FROM app_user WHERE email = $1`, [`olivia.projects${D}`])).length) return;
  const [{ id: boss } = {}] = await q(`SELECT u.id FROM app_user u JOIN staff_invite i ON i.email = lower(u.email::text) WHERE i.role = 'super_admin' AND u.email LIKE '%@demo.invalid' LIMIT 1`);
  const [{ id: james } = {}] = await q(`SELECT id FROM app_user WHERE email = $1`, [`james.buyer${D}`]);
  if (!boss || !james) { console.log("Demo project skipped: the demo staff or buyer accounts are missing."); return; }
  await client.query("BEGIN");
  try {
    const [{ id: owner }] = await q(`INSERT INTO app_user (email, display_name, user_type, status) VALUES ($1, 'Olivia Hart (project owner)', 'owner', 'active') RETURNING id`, [`olivia.projects${D}`]);
    await q(`INSERT INTO terms_acceptance (user_id, version) VALUES ($1, '2026-10-24')`, [owner]);
    const [{ id: project }] = await q(
      `INSERT INTO investment_project (owner_user_id, title, location, jurisdiction, project_type, summary, stage, funding_target_cents, minimum_ticket_cents,
         timeline, risks, structure_description, visible_to, issuer_name, issuer_licence_basis, issuer_statement, issuer_authorised_confirmed, status,
         posting_model, commission_type, commission_bps, commission_fixed_cents, upfront_fee_cents, upfront_fee_status, model2_disclosure)
       VALUES ($1, $2, 'Bulimba QLD 4171', 'QLD', 'residential_development', $3, 'approved', 240000000, 5000000, $4, $5, $6, 'wholesale_only',
         'Riverside Terraces Pty Ltd (demo)', $7, $8, true, 'approved', 'commission_on_contract', 'percent', 400, 0, 0, 'not_required', 'off') RETURNING id`,
      [owner, manifest.project.title,
       "Twelve three-bedroom townhouses on a 2,150 m2 riverside site, 400 m from Oxford Street. Development approval granted by Brisbane City Council (demo). The raise funds the equity portion of construction alongside a senior bank loan. DEMO DATA for local testing: not a real offer.",
       "DA approved Sep 2026. Construction start Feb 2027 (14 months). Practical completion and sales settlement mid 2028. Distributions after settlement.",
       "Construction cost overruns and builder insolvency; delays to approvals or weather; sale prices below forecast; interest rate rises on the senior loan; investors rank behind the bank and can lose all of their capital. Units are illiquid until the project completes.",
       "Units in the Riverside Terraces Unit Trust (demo). The trustee holds the land and contracts the builder. Investors sign the subscription deed off-platform with the issuer.",
       "Wholesale investors only (s708 Corporations Act). Issuer relies on its own AFS licence (demo number 000000).",
       "Riverside Terraces Pty Ltd is the issuer. OwnerListing does not hold money, give advice or recommend this project."]);
    await q(`INSERT INTO investment_project_status_history (project_id, from_status, to_status, actor_type, actor_id, reason, project_version, at)
             VALUES ($1, NULL, 'pending_review', 'owner', $2, NULL, 1, now() - interval '3 days'), ($1, 'pending_review', 'approved', 'staff', $3, 'Demo data: approved for local testing.', 1, now() - interval '2 days')`,
      [project, owner, boss]);
    await q(`INSERT INTO investor_declaration (user_id, category, ack_not_advice, ack_not_offer, ack_no_funds_held, ack_off_platform, disclosure_version)
             SELECT $1, 'wholesale', true, true, true, true, $2 WHERE NOT EXISTS (SELECT 1 FROM investor_declaration WHERE user_id = $1)`, [james, DISCLOSURE_VERSION]);
    const [{ id: interest }] = await q(`INSERT INTO investment_interest (project_id, investor_user_id, amount_min_cents, amount_max_cents, created_at)
             VALUES ($1, $2, 5000000, 10000000, now() - interval '1 day') RETURNING id`, [project, james]);
    for (const [sender, body, min] of [
      [james, "Hi Olivia, I've registered interest in Riverside Terraces. Could you send the information memorandum and the builder's fixed-price contract summary?", 600],
      [owner, "Hi James, thanks for your interest. I'll send the IM by email today. The builder contract is fixed price with a 5% contingency.", 420],
      [james, "Thanks. What pre-sales do you need before construction starts?", 60]]) {
      await q(`INSERT INTO investment_message (interest_id, sender_user_id, body, sent_at) VALUES ($1, $2, $3, now() - ($4 || ' minutes')::interval)`, [interest, sender, body, String(min)]);
    }
    const dir = localDevStorageDir(process.env);
    let photos = 0;
    if (dir) {
      const real = await realPhotos(manifest.project.photos);
      const pictures = real.length ? real : [exterior(5), exterior(6), floorplan(), interior(7, 0)].map((b, k) => pngPic(b, "photo", ["Architect's impression", "Site", "Plans", "Display home interior"][k]));
      const entries = await storePhotos(client, dir, "investment_project_photo", "project_id", project, owner, pictures);
      await q(`INSERT INTO investment_project_photo_layout (project_id, version, entries, changed_by) VALUES ($1, 1, $2::jsonb, $3)`, [project, JSON.stringify(entries), owner]);
      photos = entries.length;
    }
    await client.query("COMMIT");
    console.log(`Demo investor project added: "${manifest.project.title}" by Olivia Hart, ${photos} photos, James registered interest with 3 messages.`);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  }
}

// ---- Demo contractors (public pages, prices, gallery, finished jobs with feedback) ----------------------------------------------
// Four contractor accounts (photographer, building inspector, pest control, cleaner) so /contractors, a contractor page, /contractor/jobs
// and the stats have something to show. They are contractor (vendor) accounts, so /dev-login signs in as a real contractor. Photo links point at a public placeholder service. Idempotent: skipped once Priya exists.
async function seedContractors(client) {
  const D = "@demo.invalid";
  // Databases seeded before contractor sign-up have these four as agent accounts: move them to the contractor type.
  await client.query(`UPDATE app_user SET user_type = 'vendor', roles = '{}', active_role = NULL WHERE user_type = 'agent' AND email = ANY($1::text[])`,
    [["priya.photos", "tom.inspect", "greta.pest", "sam.clean"].map(k => `${k}${D}`)]);
  if ((await client.query(`SELECT 1 FROM app_user WHERE email = $1`, [`priya.photos${D}`])).rowCount) return;
  await client.query("BEGIN");
  const q = async (text, params) => (await client.query(text, params)).rows;
  const owner = (await q(`SELECT id FROM app_user WHERE email = $1`, [`sarah.owner${D}`]))[0]?.id;
  const listings = owner ? (await q(`SELECT id FROM property_listing WHERE owner_user_id = $1 ORDER BY created_at LIMIT 6`, [owner])).map(r => r.id) : [];
  const people = [
    { key: "priya.photos", name: "Priya Nair", business: "Priya Nair Property Photography", kind: "photographer", headline: "Bright, true-to-life photos, floor plans and twilight shots", licence: null,
      about: "I have photographed homes across Brisbane for eight years. I shoot with a full-frame camera and deliver edited photos within 24 hours. Drone and twilight shots on request. Please have the house tidy and the lights on.",
      suburbs: ["Paddington", "Red Hill", "Bardon", "Milton"], postcodes: ["4064", "4059", "4065"],
      services: [["Standard photos (20 images)", 18000, "fixed", "Interior and exterior, edited and delivered in 24 hours."], ["Photos and floor plan", 26000, "fixed", "20 photos plus a measured floor plan."], ["Twilight shoot", 22000, "from", "Two exterior twilight images."]],
      jobs: [["completed", 5, "Great photos, on time and easy to deal with."], ["completed", 5, "Made the house look wonderful."], ["completed", 4, "Very good. Arrived a little late but the pictures were lovely."], ["completed", 5, ""], ["cancelled", 0, ""], ["proposed", 0, ""]] },
    { key: "tom.inspect", name: "Tom Ellis", business: "Ellis Building Inspections", kind: "inspector", headline: "Pre-sale building and pest inspections, report in 48 hours", licence: ["QLD", "1234567", true],
      about: "Licensed builder with 15 years in residential construction. I give plain-English reports with photos so buyers and owners can act on them.",
      suburbs: ["Paddington", "Toowong", "Indooroopilly"], postcodes: ["4064", "4066", "4068"],
      services: [["Pre-sale building inspection", 52000, "fixed", "Structure, roof, wet areas, electrical and plumbing visible issues."], ["Combined building and pest", 69000, "fixed", "Both reports from one visit."]],
      jobs: [["completed", 5, "Thorough report, explained everything."], ["completed", 4, ""], ["proposed", 0, ""]] },
    { key: "greta.pest", name: "Greta Bauer", business: "GreenShield Pest Control", kind: "pest_control", headline: "Termite inspections and treatment, same-week bookings", licence: ["QLD", "PC-88421", false],
      about: "Family-run pest control. We inspect, report and treat termites, rodents and cockroaches with low-odour products.",
      suburbs: ["Paddington", "Bardon", "Ashgrove"], postcodes: ["4064", "4065", "4060"],
      services: [["Termite inspection and report", 19500, "fixed", ""], ["General pest treatment", 24000, "from", "Interior and exterior."]],
      jobs: [["completed", 5, "Quick and tidy."], ["proposed", 0, ""]] },
    { key: "sam.clean", name: "Sam Roe", business: "Roe Pre-sale Cleaning", kind: "other", label: "Cleaner", headline: "Make the house sparkle before photos and inspections", licence: null,
      about: "End-of-lease and pre-sale cleaning. Windows, carpets and kitchens a speciality.",
      suburbs: ["Paddington", "Milton", "Toowong"], postcodes: ["4064", "4064"],
      services: [["Pre-sale clean (3 bedroom)", 38000, "fixed", ""], ["Window cleaning", 9000, "per_hour", ""]], jobs: [] }
  ];
  for (const p of people) {
    const uid = (await q(`INSERT INTO app_user (email, display_name, user_type, status, roles, active_role) VALUES ($1, $2, 'vendor', 'active', '{}', NULL) RETURNING id`, [`${p.key}${D}`, `${p.name} (contractor)`]))[0].id;
    await q(`INSERT INTO contractor_profile (user_id, kind, accepting_new, service_postcodes, service_suburbs) VALUES ($1, $2, true, $3, $4)`, [uid, p.kind, [...new Set(p.postcodes)], p.suburbs]);
    await q(`INSERT INTO contractor_page (user_id, business_name, headline, about, trade_label, licence_number, licence_state, licence_verified_at, is_public)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)`, [uid, p.business, p.headline, p.about, p.label ?? null, p.licence?.[1] ?? null, p.licence?.[0] ?? null, p.licence?.[2] ? new Date() : null]);
    let order = 0;
    for (const [name, cents, type, desc] of p.services) await q(`INSERT INTO contractor_service (user_id, kind, name, description, price_cents, price_type, sort_order) VALUES ($1, $2, $3, nullif($4, ''), $5, $6, $7)`, [uid, p.kind, name, desc, cents, type, order++]);
    for (let i = 0; i < 4; i++) await q(`INSERT INTO contractor_media (user_id, media_type, url, caption, sort_order) VALUES ($1, 'photo', $2, $3, $4)`, [uid, `https://picsum.photos/seed/${p.key}${i}/600/450`, ["Living room", "Kitchen", "Front elevation", "Main bedroom"][i], i]);
    for (const [i, [status, rating, body]] of p.jobs.entries()) {
      const lid = listings[i % Math.max(listings.length, 1)];
      if (!owner || !lid) break;
      const ago = `${3 + i * 6} days`;
      const [job] = await q(`INSERT INTO job_assignment (listing_id, owner_user_id, contractor_user_id, kind, status, approved_at, responded_at, completed_at, created_at, service_name, price_cents, contractor_done_at)
        VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 IN ('completed') THEN now() - $6::interval END, CASE WHEN $5 <> 'proposed' THEN now() - $6::interval + interval '3 hours' END,
                CASE WHEN $5 = 'completed' THEN now() - $6::interval + interval '2 days' END, now() - $6::interval, $7, $8, CASE WHEN $5 = 'completed' THEN now() - $6::interval + interval '1 day' END) RETURNING id`,
        [lid, owner, uid, p.kind, status, ago, p.services[0][0], p.services[0][1]]);
      if (status === "completed") await q(`INSERT INTO contractor_review (assignment_id, contractor_user_id, owner_user_id, rating, body) VALUES ($1, $2, $3, $4, nullif($5, ''))`, [job.id, uid, owner, rating, body]);
    }
  }
  await client.query("COMMIT");
  console.log("Demo contractors: 4 public pages (photographer, inspector, pest control, cleaner) with prices, galleries, finished jobs and feedback.");
}

// ---- Demo map locations (search map) ------------------------------------------------------------------------------
// Approximate street positions for the eight demo listings. Only fills listings that have no pin yet, so an owner's own pin is kept.
const DEMO_LOCATIONS = [
  ["12 Jacaranda St, Paddington QLD 4064", -27.4603, 152.9998], ["8/21 Moray St, New Farm QLD 4005", -27.4669, 153.0495],
  ["45 Beach Rd, Bondi NSW 2026", -33.8917, 151.2731], ["3/17 Darley Rd, Randwick NSW 2031", -33.9124, 151.2402],
  ["28 Station St, Fitzroy North VIC 3068", -37.7838, 144.9786], ["6/102 Chapel St, Windsor VIC 3181", -37.8552, 144.9925],
  ["9/4 Park Ave, Chermside QLD 4032", -27.3857, 153.0303], ["14/50 Kent St, Sydney NSW 2000", -33.8682, 151.2047]
];
async function seedLocations(client) {
  let n = 0;
  for (const [address, lat, lng] of DEMO_LOCATIONS) {
    n += (await client.query(`UPDATE property_listing SET latitude = $2, longitude = $3 WHERE address_text = $1 AND latitude IS NULL`, [address, lat, lng])).rowCount ?? 0;
  }
  if (n) console.log(`Demo map locations added: ${n} listings.`);
}

// ---- Demo files (listing Files page) ------------------------------------------------------------------------------------
// The upload form refuses a listing with no property record, so every demo listing gets one. The eight main demo listings then get example
// files: floor plan, 360 photo, title search, building inspection, pest report and a contract with an earlier, superseded version.
// Bytes are written only when LOCAL_STORAGE_DIR is set (same guard as the photos); rows are added either way. Idempotent.

/** A one-page PDF with a title and text lines (Helvetica, no external fonts). */
function makePdf(title, lines) {
  const esc = s => s.replace(/[\\()]/g, m => `\\${m}`);
  let stream = `BT /F1 18 Tf 56 780 Td (${esc(title)}) Tj ET\n`;
  lines.forEach((t, i) => { stream += `BT /F1 11 Tf 56 ${740 - i * 18} Td (${esc(t)}) Tj ET\n`; });
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let out = "%PDF-1.4\n"; const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
/** A 2:1 equirectangular-style panorama: sky, distant ridge, lawn, with the horizon at mid height. */
function panorama(p) {
  const [accent] = PALETTES[p % PALETTES.length];
  return makePng(1600, 800, (x, y) => {
    const ridge = 330 + Math.sin(x / 90) * 24 + Math.sin(x / 31) * 8;
    if (y > 400) return mix([96, 150, 78], [60, 110, 55], (y - 400) / 400);
    if (y > ridge) return mix(accent, [60, 70, 80], 0.5);
    return mix([120, 175, 235], [225, 238, 250], y / 400);
  });
}

async function seedFiles(client) {
  let linked = 0;
  const bare = (await client.query(`SELECT id, address_text, jurisdiction, suburb, postcode, use_class, property_type, bedrooms, bathrooms, parking, latitude, longitude FROM property_listing WHERE property_id IS NULL AND owner_user_id IN (SELECT id FROM app_user WHERE email LIKE '%@demo.invalid')`)).rows;
  for (const l of bare) {
    const pid = (await client.query(
      `INSERT INTO property (address_text, state, suburb, postcode, use_class, property_type, bedrooms, bathrooms, car_spaces, latitude, longitude)
       VALUES ($1, TRIM($2), $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [l.address_text, l.jurisdiction, l.suburb, l.postcode, l.use_class, l.property_type, l.bedrooms, l.bathrooms, l.parking, l.latitude, l.longitude])).rows[0].id;
    await client.query(`UPDATE property_listing SET property_id = $2 WHERE id = $1`, [l.id, pid]);
    linked++;
  }
  const dir = localDevStorageDir(process.env);
  const targets = (await client.query(
    `SELECT l.id, l.owner_user_id, l.property_id, l.address_text, l.transaction_type FROM property_listing l
      WHERE l.address_text = ANY($1::text[]) AND l.property_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM property_document d WHERE d.listing_id = l.id)
      ORDER BY l.created_at, l.id`, [DEMO_LOCATIONS.map(d => d[0])])).rows;
  let made = 0;
  for (const [i, l] of targets.entries()) {
    const sale = l.transaction_type === "sale";
    const files = [
      ["floorplan", "image/png", "public", floorplan(), null],
      ...(i % 2 === 0 ? [["photo_360", "image/png", "public", panorama(i), null]] : []),
      ["title_search", "application/pdf", "owner_only", makePdf("Title search", [l.address_text, "Registered proprietor: as per owner account", "Encumbrances: none recorded", "Searched: demo data, not a real search"]), null],
      ["building_inspection", "application/pdf", "parties", makePdf("Building inspection report", [l.address_text, "Overall condition: good", "Minor items: gutters, two loose roof tiles", "Demo document, not a real inspection"]), null],
      ["pest_report", "application/pdf", "parties", makePdf("Timber pest report", [l.address_text, "No active termite activity found", "Re-inspect in 12 months", "Demo document, not a real report"]), null],
      ...(sale ? [["contract", "application/pdf", "parties", makePdf("Contract of sale (draft 1)", [l.address_text, "Superseded by draft 2 after the owner's edits", "Demo document"]), "old"],
                  ["contract", "application/pdf", "parties", makePdf("Contract of sale (draft 2)", [l.address_text, "Special conditions: finance and building inspection", "Demo document"]), "new"]] : [])
    ];
    let oldId = null;
    for (const [kind, mime, visibility, bytes, ver] of files) {
      const id = randomUUID(), key = `listings/${l.id}/${randomUUID()}`;
      if (dir) await putLocalObject(dir, key, bytes);
      await client.query(
        `INSERT INTO property_document (id, property_id, listing_id, kind, storage_key, sha256, uploaded_by, source, declared_mime, size_bytes, visibility, status, supersedes_id, uploaded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'owner_supplied', $8, $9, $10, $11, $12, now() - ($13::int * interval '1 day'))`,
        [id, l.property_id, l.id, kind, key, createHash("sha256").update(bytes).digest("hex"), l.owner_user_id, mime, bytes.length, visibility,
          ver === "old" ? "superseded" : "active", ver === "new" ? oldId : null, 12 - made % 9]);
      if (ver === "old") oldId = id;
      made++;
    }
  }
  if (linked || made) console.log(`Demo files: ${linked} listings given a property record, ${made} example files added${dir ? "" : " (no bytes: LOCAL_STORAGE_DIR is not set)"}.`);
}

// ---- Demo disclosures and public documents (property page: Disclosures and Documents sections) ---------------------------------
// Each demo listing gets the disclosures and public documents that fit its state and kind (sale or rent), so buyers see realistic
// trust signals. Illustrative demo data only: the keys and titles are not a statement of what a state requires (that comes from
// compliance configuration, which counsel signs off). Idempotent: disclosures are unique per listing and key, documents per listing and title.
const DEMO_DISCLOSURES = {
  "12 Jacaranda St, Paddington QLD 4064": ["qld_seller_disclosure_statement", "qld_pool_safety_sale", "qld_flood_search", "qld_smoke_alarm_compliance_sale", "building_pest_report"],
  "8/21 Moray St, New Farm QLD 4005": ["qld_smoke_alarm_compliance_rental", "qld_minimum_housing_standards", "energy_rating"],
  "45 Beach Rd, Bondi NSW 2026": ["nsw_contract_of_sale", "nsw_zoning_certificate", "nsw_sewer_service_diagram", "nsw_flood_bushfire", "building_pest_report"],
  "3/17 Darley Rd, Randwick NSW 2031": ["nsw_smoke_alarm_rental", "energy_rating"],
  "28 Station St, Fitzroy North VIC 3068": ["vic_section_32", "vic_building_permits", "vic_heritage_overlay", "vic_land_tax_certificate", "building_pest_report"],
  "6/102 Chapel St, Windsor VIC 3181": ["vic_rental_minimum_standards", "smoke_alarm_compliance", "energy_rating"],
  "9/4 Park Ave, Chermside QLD 4032": ["qld_seller_disclosure_statement", "qld_body_corporate_certificate", "qld_smoke_alarm_compliance_sale", "title_search"],
  "14/50 Kent St, Sydney NSW 2000": ["nsw_smoke_alarm_rental", "nsw_strata_certificate", "energy_rating"]
};
// [kind, title, extra lines on the PDF]
const DEMO_PUBLIC_DOCS = {
  "12 Jacaranda St, Paddington QLD 4064": [["other", "Form 2 seller disclosure summary", ["Zoning: Low-medium density residential", "Pool: certificate current", "Demo document"]], ["title_search", "Title search, Lot 7 on RP 21345", ["Freehold, one registered mortgage to be discharged on settlement"]], ["other", "Brisbane flood awareness report", ["Flood risk: low for river flooding, medium for creek flooding"]], ["building_inspection", "Building inspection summary", ["Overall condition: good"]]],
  "8/21 Moray St, New Farm QLD 4005": [["other", "Smoke alarm compliance certificate", ["Interconnected photoelectric alarms in every bedroom and hallway"]], ["other", "Energy rating summary", ["Ceiling fans in all rooms, split system in living area"]], ["other", "Entry condition report (sample)", ["Provided at lease signing, 7 days to return"]]],
  "45 Beach Rd, Bondi NSW 2026": [["other", "Planning certificate (section 10.7)", ["Zoning: R2 Low density residential", "Heritage conservation area: yes", "Bush fire prone: no"]], ["other", "Sydney Water sewer service diagram", ["Connected to the sewer main at the rear boundary"]], ["other", "Survey report, 2019", ["Boundaries pegged, no encroachments noted"]], ["pest_report", "Timber pest inspection summary", ["No active termite activity found"]]],
  "3/17 Darley Rd, Randwick NSW 2031": [["other", "Smoke alarm compliance certificate", ["Hardwired alarms checked this year"]], ["other", "Energy rating summary", ["Dishwasher and split systems rated 4 star or higher"]], ["other", "Condition report (sample)", ["Provided at lease signing"]]],
  "28 Station St, Fitzroy North VIC 3068": [["other", "Vendor's statement summary (section 32)", ["Title, rates, services and planning overlays attached", "Demo document"]], ["other", "Building permit history", ["Rear extension 2016, final certificate issued"]], ["other", "Heritage overlay summary", ["HO316 applies: external changes need a planning permit"]], ["title_search", "Certificate of title", ["Volume 10432, Folio 118"]]],
  "6/102 Chapel St, Windsor VIC 3181": [["other", "Rental minimum standards declaration", ["Locks, heating, vents, mould and electrical safety checked"]], ["other", "Gas and electrical safety check", ["Completed within the last two years"]], ["other", "Energy rating summary", ["Efficient reverse-cycle heating installed"]]],
  "9/4 Park Ave, Chermside QLD 4032": [["other", "Body corporate information certificate", ["Levies up to date, no special levies planned"]], ["other", "Survey plan (BUP 4471)", ["Community titles scheme, four lots"]], ["title_search", "Title search summary", ["Freehold lot in a community titles scheme"]], ["other", "Smoke alarm compliance certificate", ["Interconnected alarms tested"]]],
  "14/50 Kent St, Sydney NSW 2000": [["other", "Strata information summary", ["Levies and by-laws, short stay not permitted"]], ["other", "Smoke alarm compliance certificate", ["Building fire safety statement current"]], ["other", "Energy rating summary", ["Efficient appliances, double glazed windows"]]]
};
async function seedDisclosuresAndPublicDocs(client) {
  const staff = (await client.query(`SELECT id FROM app_user WHERE email = $1`, [`staff.super_admin${D}`])).rows[0]?.id
    ?? (await client.query(`SELECT id FROM app_user WHERE email LIKE '%@demo.invalid' ORDER BY created_at LIMIT 1`)).rows[0]?.id;
  const dir = localDevStorageDir(process.env);
  let disclosures = 0, docs = 0;
  for (const [address, keys] of Object.entries(DEMO_DISCLOSURES)) {
    const l = (await client.query(`SELECT id, jurisdiction, owner_user_id, property_id FROM property_listing WHERE address_text = $1`, [address])).rows[0];
    if (!l) continue;
    for (const [i, key] of keys.entries()) {
      disclosures += (await client.query(
        `INSERT INTO listing_disclosure (listing_id, jurisdiction, disclosure_key, satisfied, evidence_reference, verified_by, verified_at, state)
         VALUES ($1, $2, $3, true, 'demo-evidence', $4, now() - ($5::int * interval '1 day'), 'verified') ON CONFLICT (listing_id, disclosure_key) DO NOTHING`,
        [l.id, l.jurisdiction.trim(), key, staff, i + 2])).rowCount ?? 0;
    }
    if (!l.property_id) continue;
    for (const [kind, title, lines] of DEMO_PUBLIC_DOCS[address] ?? []) {
      if ((await client.query(`SELECT 1 FROM property_document WHERE listing_id = $1 AND title = $2`, [l.id, title])).rowCount) continue;
      const bytes = makePdf(title, [address, ...lines, "Demo document, not a real record"]);
      const key = `listings/${l.id}/${randomUUID()}`;
      if (dir) await putLocalObject(dir, key, bytes);
      await client.query(
        `INSERT INTO property_document (property_id, listing_id, kind, title, storage_key, sha256, uploaded_by, source, declared_mime, size_bytes, visibility, status, uploaded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'owner_supplied', 'application/pdf', $8, 'public', 'active', now() - ($9::int * interval '1 day'))`,
        [l.property_id, l.id, kind, title, key, createHash("sha256").update(bytes).digest("hex"), l.owner_user_id, bytes.length, 3 + docs % 20]);
      docs++;
    }
  }
  if (disclosures || docs) console.log(`Demo disclosures: ${disclosures} added. Public documents: ${docs} added${dir ? "" : " (no bytes: LOCAL_STORAGE_DIR is not set)"}.`);
}

// ---- Demo agent leads (/agent/leads) ------------------------------------------------------------------------------------
// Five extra buyers and about 20 leads for Mia, Priya and Tom in every status (new, viewing, offer, converted, lost) with interaction history,
// follow-ups and notes. Needs the agents from seedPerformanceAndMessages. Idempotent: leads are unique per listing, agent and buyer.
async function seedLeads(client) {
  const find = async email => (await client.query(`SELECT id FROM app_user WHERE email = $1`, [email + D])).rows[0]?.id;
  const who = { mia: await find("mia.agent"), priya: await find("priya.agent"), tom: await find("tom.agent"), james: await find("james.buyer"),
    emma: await find("emma.buyer"), liam: await find("liam.buyer"), noah: await find("noah.investor") };
  if (Object.values(who).some(v => !v)) return;
  for (const [key, name, phone] of [["olivia", "Olivia Reyes", "+61400000011"], ["marcus", "Marcus Lee", "+61400000012"], ["aisha", "Aisha Rahman", "+61400000013"],
    ["ben", "Ben Taylor", "+61400000014"], ["chloe", "Chloe Martin", "+61400000015"]]) {
    let id = await find(`${key}.buyer`);
    if (!id) {
      id = (await client.query(`INSERT INTO app_user (email, display_name, user_type, status, roles, active_role) VALUES ($1, $2, 'buyer', 'active', ARRAY['buyer'], 'buyer') RETURNING id`, [`${key}.buyer${D}`, name])).rows[0].id;
      await client.query(`INSERT INTO terms_acceptance (user_id, version) VALUES ($1, '2026-10-24')`, [id]);
      await client.query(`INSERT INTO buyer_verification (user_id, email_verified_at, phone_verified_at, phone_e164) VALUES ($1, now(), now(), $2)`, [id, phone]);
    }
    who[key] = id;
  }
  const listing = async address => (await client.query(`SELECT id FROM property_listing WHERE address_text = $1`, [address])).rows[0]?.id;
  const A = { jac: "12 Jacaranda St, Paddington QLD 4064", latrobe: "31 Latrobe Tce, Paddington QLD 4064", oxford: "5/18 Oxford St, Bulimba QLD 4171", haw: "77 Hawthorne Rd, Ascot QLD 4007",
    comm: "12/40 Commercial Rd, Teneriffe QLD 4005", dolphin: "9/14 Dolphin St, Coogee NSW 2034", illa: "22 Illawarra Rd, Marrickville NSW 2204", bed: "8 Bedford St, Newtown NSW 2042",
    crown: "3/90 Crown St, Surry Hills NSW 2010", alb: "14 Albert St, Brunswick VIC 3056", high: "61 High St, Northcote VIC 3070", bridge: "11/200 Bridge Rd, Richmond VIC 3121", rath: "27 Rathdowne St, Carlton VIC 3053" };
  // [agent, listing, buyer, status, created h ago, last buyer h, last agent h|null, interactions [type, actor, text, h ago], extra]
  const leads = [
    ["mia", "jac", "olivia", "new_inquiry", 3, 3, null, [["inquiry", "buyer", "Sent an enquiry about the listing", 3]], {}],
    ["mia", "jac", "marcus", "viewing_scheduled", 52, 30, 28, [["inquiry", "buyer", "Sent an enquiry about the listing", 52], ["message", "agent", "You replied to the buyer", 50], ["viewing", "buyer", "Asked to view the property on Saturday 10:00", 30], ["message", "agent", "You replied to the buyer", 28]], { follow: 20, fnote: "Confirm Saturday viewing and ask about finance pre-approval" }],
    ["mia", "jac", "aisha", "offer_pending", 120, 6, 8, [["inquiry", "buyer", "Sent an enquiry about the listing", 120], ["viewing", "buyer", "Asked to view the property on Sunday 11:30", 90], ["message", "agent", "You replied to the buyer", 88], ["offer", "buyer", "Buyer submitted an offer", 6]], { notes: ["Pre-approved to $1.65m. Wants a quick settlement, 30 days.", "Spoke by phone: loves the pool, asked about solar."] }],
    ["mia", "jac", "ben", "lost", 400, 300, 296, [["inquiry", "buyer", "Sent an enquiry about the listing", 400], ["message", "agent", "You replied to the buyer", 398], ["message", "buyer", "Buyer sent a message", 300]], { lost: "budget", lnote: "Looking under $1.4m." }],
    ["mia", "jac", "chloe", "lost", 360, 340, 338, [["inquiry", "buyer", "Sent an enquiry about the listing", 360], ["message", "agent", "You replied to the buyer", 338]], { lost: "location", lnote: "Wants to stay closer to the CBD train line." }],
    ["mia", "oxford", "marcus", "viewing_scheduled", 200, 190, 189, [["inquiry", "buyer", "Sent an enquiry about the listing", 200], ["inspection", "buyer", "Requested a property inspection", 190]], { follow: -6, fnote: "Overdue: send the strata report" }],
    ["mia", "haw", "aisha", "lost", 2400, 2300, 2290, [["inquiry", "buyer", "Sent an enquiry about the listing", 2400], ["message", "agent", "You replied to the buyer", 2290]], { lost: "other", lnote: "Bought another property before the open home." }],
    ["priya", "dolphin", "olivia", "viewing_scheduled", 70, 40, 38, [["inquiry", "buyer", "Sent an enquiry about the listing", 70], ["message", "agent", "You replied to the buyer", 68], ["viewing", "buyer", "Asked to view the property on Saturday 09:30", 40]], { follow: 30, fnote: "Send body corporate minutes before the viewing" }],
    ["priya", "dolphin", "ben", "lost", 500, 420, 418, [["inquiry", "buyer", "Sent an enquiry about the listing", 500], ["message", "agent", "You replied to the buyer", 418]], { lost: "budget", lnote: "Needs two bedrooms under $1m." }],
    ["priya", "dolphin", "aisha", "new_inquiry", 1, 1, null, [["inquiry", "buyer", "Sent an enquiry about the listing", 1]], {}],
    ["priya", "crown", "marcus", "offer_pending", 150, 12, 14, [["inquiry", "buyer", "Sent an enquiry about the listing", 150], ["viewing", "buyer", "Asked to view the property on Thursday 17:30", 110], ["offer", "buyer", "Buyer submitted an offer", 12]], { notes: ["Cash buyer, no finance clause."] }],
    ["tom", "rath", "chloe", "lost", 900, 800, 796, [["inquiry", "buyer", "Sent an enquiry about the listing", 900], ["message", "agent", "You replied to the buyer", 796]], { lost: "location", lnote: "Prefers the northern suburbs." }],
    ["tom", "alb", "olivia", "new_inquiry", 20, 20, null, [["inquiry", "buyer", "Sent an enquiry about the listing", 20]], {}],
    ["tom", "high", "ben", "viewing_scheduled", 80, 55, 50, [["inquiry", "buyer", "Sent an enquiry about the listing", 80], ["viewing", "buyer", "Asked to view the property on Friday 12:00", 55], ["message", "agent", "You replied to the buyer", 50]], { follow: 8, fnote: "Call after the viewing" }],
    ["tom", "bridge", "liam", "lost", 1700, 1600, 1598, [["inquiry", "buyer", "Sent an enquiry about the listing", 1700], ["offer", "buyer", "Buyer submitted an offer", 1650], ["message", "agent", "You replied to the buyer", 1598]], { lost: "budget", lnote: "Finance fell through after the valuation." }]
  ];
  // Converted leads: the buyers whose offers were accepted on the sales seeded earlier.
  const converted = [["mia", "latrobe", "james"], ["mia", "oxford", "emma"], ["mia", "haw", "liam"], ["priya", "dolphin", "james"], ["priya", "illa", "noah"], ["priya", "bed", "liam"],
    ["priya", "crown", "james"], ["tom", "alb", "james"], ["tom", "high", "emma"], ["tom", "rath", "liam"]];
  let made = 0;
  await client.query("BEGIN");
  try {
    for (const [ag, ad, b, status, created, lastB, lastA, inter, x] of leads) {
      const lid = await listing(A[ad]);
      if (!lid) continue;
      const lastInt = Math.min(...inter.map(i => i[3]));
      const notes = (x.notes ?? []).map((text, k) => ({ id: randomUUID(), at: new Date(Date.now() - (lastInt + 2 + k) * 3600e3).toISOString(), by: who[ag], text }));
      const r = (await client.query(
        `INSERT INTO agent_lead (listing_id, agent_id, buyer_id, status, lost_reason, lost_note, created_at, last_interaction_at, last_buyer_at, last_agent_at, first_response_at, next_followup_at, followup_note, notes)
         VALUES ($1, $2, $3, $4, $5, $6, now() - $7::int * interval '1 hour', now() - $8::int * interval '1 hour', now() - $9::int * interval '1 hour',
                 CASE WHEN $10::int IS NULL THEN NULL ELSE now() - $10::int * interval '1 hour' END, CASE WHEN $10::int IS NULL THEN NULL ELSE now() - $10::int * interval '1 hour' END,
                 CASE WHEN $11::int IS NULL THEN NULL ELSE now() + $11::int * interval '1 hour' END, $12, $13::jsonb)
         ON CONFLICT (listing_id, agent_id, buyer_id) DO NOTHING RETURNING id`,
        [lid, who[ag], who[b], status, x.lost ?? null, x.lnote ?? "", created, lastInt, lastB, lastA, x.follow ?? null, x.fnote ?? "", JSON.stringify(notes)])).rows[0];
      if (!r) continue;
      for (const [type, actor, text, h] of inter) {
        await client.query(`INSERT INTO lead_interaction (lead_id, interaction_type, actor, description, created_at) VALUES ($1, $2, $3, $4, now() - $5::int * interval '1 hour')`, [r.id, type, actor, text, h]);
      }
      made++;
    }
    for (const [ag, ad, b] of converted) {
      const lid = await listing(A[ad]);
      if (!lid) continue;
      const offer = (await client.query(`SELECT id FROM formal_offer WHERE listing_id = $1 AND buyer_user_id = $2 AND status = 'accepted' LIMIT 1`, [lid, who[b]])).rows[0]?.id;
      if (!offer) continue;
      const r = (await client.query(
        `INSERT INTO agent_lead (listing_id, agent_id, buyer_id, status, converted_offer_id, created_at, last_interaction_at, last_buyer_at, last_agent_at, first_response_at)
         VALUES ($1, $2, $3, 'converted', $4, now() - interval '30 days', now() - interval '10 days', now() - interval '11 days', now() - interval '10 days', now() - interval '30 days' + interval '2 hours')
         ON CONFLICT (listing_id, agent_id, buyer_id) DO UPDATE SET status = 'converted', converted_offer_id = EXCLUDED.converted_offer_id, next_followup_at = NULL RETURNING id,
           (xmax = 0) AS fresh`, [lid, who[ag], who[b], offer])).rows[0];
      if (!r.fresh) continue;
      for (const [type, actor, text, d] of [["inquiry", "buyer", "Sent an enquiry about the listing", 30], ["message", "agent", "You replied to the buyer", 30], ["viewing", "buyer", "Asked to view the property", 25], ["offer", "buyer", "Buyer submitted an offer", 12], ["offer", "system", "The owner accepted the buyer's offer", 10]]) {
        await client.query(`INSERT INTO lead_interaction (lead_id, interaction_type, actor, description, created_at) VALUES ($1, $2, $3, $4, now() - $5::int * interval '1 day')`, [r.id, type, actor, text, d]);
      }
      made++;
    }
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK").catch(() => undefined); throw e; }
  if (made) console.log(`Demo agent leads added: ${made} leads across Mia, Priya and Tom (new, viewing, offer, converted, lost).`);
}

// ---- Demo floor plan + video on every demo listing (also listings seeded before this existed) -------------------------
// Adds a floor plan to the current gallery (a new layout version) and a public video file where missing. Idempotent.
async function seedMedia(client) {
  const dir = localDevStorageDir(process.env);
  if (!dir) return;
  const plan = floorplanImage(), video = readFileSync(new URL("demo-tour.mp4", MEDIA_DIR));
  const rows = (await client.query(
    `SELECT l.id, l.owner_user_id, l.property_id FROM property_listing l JOIN app_user u ON u.id = l.owner_user_id
      WHERE u.email LIKE '%@demo.invalid' ORDER BY l.created_at, l.id`)).rows;
  let plans = 0, videos = 0;
  for (const l of rows) {
    const lay = (await client.query(`SELECT version, entries, tour_url FROM listing_photo_layout WHERE listing_id = $1 ORDER BY version DESC LIMIT 1`, [l.id])).rows[0];
    if (lay && !(await client.query(`SELECT 1 FROM listing_photo WHERE listing_id = $1 AND kind = 'floorplan'`, [l.id])).rowCount) {
      const id = randomUUID(), key = `listings/${l.id}/${randomUUID()}`;
      await putLocalObject(dir, key, plan);
      await client.query(
        `INSERT INTO listing_photo (id, listing_id, kind, uploaded_by, content_type, width, height, size_bytes, sha256, storage_key)
         VALUES ($1, $2, 'floorplan', $3, 'image/png', 1600, 1067, $4, $5, $6)`, [id, l.id, l.owner_user_id, plan.length, createHash("sha256").update(plan).digest("hex"), key]);
      const entries = [...lay.entries, { photoId: id, caption: "Floor plan", alt: "", hidden: false }];
      await client.query(`INSERT INTO listing_photo_layout (listing_id, version, entries, tour_url, changed_by) VALUES ($1, $2, $3::jsonb, $4, $5)`,
        [l.id, lay.version + 1, JSON.stringify(entries), lay.tour_url, l.owner_user_id]);
      plans++;
    }
    if (l.property_id && !(await client.query(`SELECT 1 FROM property_document WHERE listing_id = $1 AND kind = 'video'`, [l.id])).rowCount) {
      const id = randomUUID(), key = `listings/${l.id}/${randomUUID()}`;
      await putLocalObject(dir, key, video);
      await client.query(
        `INSERT INTO property_document (id, property_id, listing_id, kind, storage_key, sha256, uploaded_by, source, declared_mime, size_bytes, visibility, status, uploaded_at)
         VALUES ($1, $2, $3, 'video', $4, $5, $6, 'owner_supplied', 'video/mp4', $7, 'public', 'active', now())`,
        [id, l.property_id, l.id, key, createHash("sha256").update(video).digest("hex"), l.owner_user_id, video.length]);
      videos++;
    }
  }
  if (plans || videos) console.log(`Demo media: ${plans} floor plans and ${videos} videos added.`);
}

// ---- Example listings for one demo owner (My listings) --------------------------------------------------------------------------
// Marcus Bell (marcus.owner) owns 36 fully populated sale listings across NSW, VIC and QLD (1-bed units to 5+ bed estates). Each has an owner-written description, map pin, a property
// record, state-specific documents with verified disclosures, a trust account check, and open inspection times. Photos, floor plan and tour video are
// added by seedPhotos and seedMedia (this owner is a demo account). Council and water rates and the finance example are written into the description:
// the listing has no separate fields for them. Idempotent: a listing is skipped when this owner already has that address.
const EXAMPLE_OWNER = "marcus.owner";
const loan = (price, rate = 0.062) => { const p = price * 0.8, r = rate / 12, n = 360; return Math.round(p * r / (1 - (1 + r) ** -n)); };
const money = n => `$${n.toLocaleString("en-AU")}`;
const EXAMPLES = [
  { state: "NSW", suburb: "Bondi Beach", postcode: "2026", type: "unit", address: "12/88 Campbell Parade, Bondi Beach NSW 2026", lat: -33.8915, lng: 151.2767, beds: 2, baths: 1, cars: 1,
    title: "Bright two-bedroom apartment steps from Bondi Beach", price: 1450000, amenities: ["balcony", "air_conditioning", "lift", "security"],
    intro: "A light-filled apartment on the third floor, two minutes' walk to the sand. North-facing balcony, polished timber floors, a renovated kitchen with stone benchtops and a secure car space in the basement.",
    rates: { council: 412, water: 168, strata: 1180 }, docs: "nsw", times: [[6, 600, 660], [3, 1050, 1110]] },
  { state: "NSW", suburb: "Manly", postcode: "2095", type: "house", address: "21 Raglan Street, Manly NSW 2095", lat: -33.7969, lng: 151.2840, beds: 4, baths: 3, cars: 2,
    title: "Family home with a pool and a short walk to Manly Wharf", price: 2980000, amenities: ["pool", "garden", "solar", "garage", "air_conditioning", "ensuite"],
    intro: "A generous four-bedroom home on a quiet street. Open-plan living flows to a north-facing garden and heated pool, the main bedroom has an ensuite and walk-in robe, and the double garage has internal access. Solar panels keep power bills low.",
    rates: { council: 548, water: 196, strata: 0 }, docs: "nsw", times: [[6, 570, 630], [0, 600, 660]] },
  { state: "NSW", suburb: "Parramatta", postcode: "2150", type: "townhouse", address: "5/31 Macarthur Street, Parramatta NSW 2150", lat: -33.8150, lng: 151.0011, beds: 3, baths: 2, cars: 2,
    title: "Modern three-bedroom townhouse near the river", price: 945000, amenities: ["air_conditioning", "garage", "balcony", "study"],
    intro: "A low-maintenance townhouse in a small complex of eight. Three bedrooms upstairs, a study nook, a sunny courtyard and a double lock-up garage. Walk to the light rail, the river and the Westfield.",
    rates: { council: 386, water: 154, strata: 760 }, docs: "nsw", times: [[6, 660, 720], [4, 1080, 1140]] },
  { state: "VIC", suburb: "Brunswick", postcode: "3056", type: "house", address: "63 Albert Street, Brunswick VIC 3056", lat: -37.7664, lng: 144.9600, beds: 3, baths: 2, cars: 1,
    title: "Renovated Victorian terrace in the heart of Brunswick", price: 1325000, amenities: ["garden", "air_conditioning", "solar", "study"],
    intro: "A beautifully renovated terrace that keeps its period details: high ceilings, timber floors and original fireplaces. A rear extension adds an open kitchen and dining room opening to a leafy garden, and there is off-street parking at the back.",
    rates: { council: 462, water: 171, strata: 0 }, docs: "vic", times: [[6, 600, 660], [2, 1050, 1110]] },
  { state: "VIC", suburb: "Richmond", postcode: "3121", type: "unit", address: "9/14 Bridge Road, Richmond VIC 3121", lat: -37.8183, lng: 144.9984, beds: 2, baths: 2, cars: 1,
    title: "Stylish two-bedroom apartment close to Swan Street", price: 780000, amenities: ["balcony", "air_conditioning", "lift", "security", "ensuite"],
    intro: "A contemporary apartment in a boutique block of twelve. Two bedrooms with built-in robes, an ensuite to the main, a covered balcony and a secure car space. Cafes, trams and the MCG precinct are on your doorstep.",
    rates: { council: 301, water: 142, strata: 1020 }, docs: "vic", times: [[6, 630, 690], [3, 1080, 1140]] },
  { state: "QLD", suburb: "Bulimba", postcode: "4171", type: "house", address: "34 Oxford Street, Bulimba QLD 4171", lat: -27.4502, lng: 153.0586, beds: 4, baths: 2, cars: 2,
    title: "Elevated Queenslander with a pool, minutes to Oxford Street", price: 1895000, amenities: ["pool", "garden", "air_conditioning", "garage", "balcony"],
    intro: "A character Queenslander raised high on a 607 sqm block. Wide verandahs, VJ walls and polished hoop pine floors sit alongside a modern kitchen. Downstairs has a second living area, a laundry and a double garage, and the saltwater pool is fenced to current standards.",
    rates: { council: 623, water: 214, strata: 0 }, docs: "qld", times: [[6, 600, 660], [3, 1050, 1110]] },
  // ---- 30 more examples: 1-bed units to 5+ bed estates, entry-level to premium, renovated and needs-work, across NSW, VIC and QLD ----
  { state: "NSW", suburb: "Newtown", postcode: "2042", type: "unit", address: "4/62 King Street, Newtown NSW 2042", lat: -33.8960, lng: 151.1796, beds: 1, baths: 1, cars: 0,
    title: "Compact one-bedroom apartment above King Street", price: 640000, amenities: ["air_conditioning", "balcony"],
    intro: "A neat one-bedroom apartment in a boutique 1930s block. Polished boards, a north-facing balcony and a European laundry. No car space, but the train station, buses and King Street cafes are all a short walk away. A solid entry-level buy or investment.",
    rates: { council: 265, water: 132, strata: 890 }, docs: "nsw", times: [[6, 600, 660], [2, 1080, 1140]] },
  { state: "NSW", suburb: "Penrith", postcode: "2750", type: "unit", address: "17/9 Henry Street, Penrith NSW 2750", lat: -33.7511, lng: 150.6942, beds: 1, baths: 1, cars: 1,
    title: "Affordable one-bedroom unit near Penrith station", price: 435000, amenities: ["air_conditioning", "lift", "security"],
    intro: "A tidy one-bedroom unit on the fifth floor with a lock-up car space. Open-plan living, a modern kitchen and a bedroom with a built-in robe. Five minutes' walk to the station and Westfield Penrith. Ideal for first home buyers.",
    rates: { council: 248, water: 120, strata: 780 }, docs: "nsw", times: [[0, 600, 660], [6, 780, 840]] },
  { state: "NSW", suburb: "Wollongong", postcode: "2500", type: "unit", address: "22/40 Market Street, Wollongong NSW 2500", lat: -34.4247, lng: 150.8946, beds: 2, baths: 2, cars: 1,
    title: "Two-bedroom apartment with ocean glimpses", price: 695000, amenities: ["balcony", "air_conditioning", "lift", "pool", "security"],
    intro: "A modern two-bedroom, two-bathroom apartment with a sunny balcony and glimpses of the water. The building has a resort-style pool and gym. Walk to the beach, the Crown Street Mall and the train.",
    rates: { council: 290, water: 138, strata: 1240 }, docs: "nsw", times: [[6, 630, 690], [3, 1050, 1110]] },
  { state: "NSW", suburb: "Marrickville", postcode: "2204", type: "townhouse", address: "3/55 Illawarra Road, Marrickville NSW 2204", lat: -33.9107, lng: 151.1558, beds: 2, baths: 1, cars: 1,
    title: "Two-bedroom townhouse with a courtyard in Marrickville", price: 1050000, amenities: ["garden", "air_conditioning", "pet_friendly"],
    intro: "A quiet townhouse at the back of a small group of three. Two bedrooms, a renovated bathroom, a timber kitchen and a private courtyard that suits a dog. Close to the Marrickville Metro, cafes and the light rail.",
    rates: { council: 340, water: 146, strata: 520 }, docs: "nsw", times: [[6, 570, 630], [4, 1080, 1140]] },
  { state: "NSW", suburb: "Cronulla", postcode: "2230", type: "townhouse", address: "2/14 Kingsway, Cronulla NSW 2230", lat: -34.0538, lng: 151.1522, beds: 3, baths: 2, cars: 2,
    title: "Three-bedroom townhouse close to Cronulla Beach", price: 1780000, amenities: ["garage", "balcony", "air_conditioning", "garden", "ensuite"],
    intro: "A light, split-level townhouse a few streets from the sand. Three bedrooms with an ensuite to the main, a covered entertaining terrace and a double garage. Fresh paint and new carpet throughout.",
    rates: { council: 395, water: 160, strata: 610 }, docs: "nsw", times: [[6, 600, 660], [0, 600, 660]] },
  { state: "NSW", suburb: "Gosford", postcode: "2250", type: "house", address: "18 Mann Street, Gosford NSW 2250", lat: -33.4254, lng: 151.3417, beds: 3, baths: 1, cars: 1,
    title: "Original three-bedroom home with big potential", price: 820000, amenities: ["garden"],
    intro: "A solid brick home on a flat 640 sqm block, in original condition and ready for a renovator. Three bedrooms, a sunroom and a large backyard with room for a pool or a granny flat (subject to council approval). Needs updating, priced accordingly.",
    rates: { council: 372, water: 150, strata: 0 }, docs: "nsw", times: [[6, 600, 660], [3, 1050, 1110]] },
  { state: "NSW", suburb: "Orange", postcode: "2800", type: "house", address: "41 Summer Street, Orange NSW 2800", lat: -33.2835, lng: 149.1000, beds: 4, baths: 2, cars: 2,
    title: "Four-bedroom family home with a wood heater and garden", price: 760000, amenities: ["garden", "garage", "air_conditioning", "solar"],
    intro: "A spacious brick home in a quiet pocket of Orange. Four bedrooms, a wood fire and reverse-cycle air conditioning, a big family kitchen and a landscaped garden with fruit trees. Solar panels and a double garage.",
    rates: { council: 330, water: 128, strata: 0 }, docs: "nsw", times: [[6, 570, 630], [0, 600, 660]] },
  { state: "NSW", suburb: "Mosman", postcode: "2088", type: "house", address: "9 Awaba Street, Mosman NSW 2088", lat: -33.8280, lng: 151.2430, beds: 4, baths: 3, cars: 2,
    title: "Renovated family residence in the heart of Mosman", price: 4350000, amenities: ["pool", "garden", "garage", "air_conditioning", "ensuite", "study", "security"],
    intro: "A fully renovated four-bedroom residence on a level 720 sqm block. Designer kitchen with butler's pantry, a study, a sparkling pool and a landscaped garden with a covered terrace. Zoned for top local schools, a short walk to Mosman Village.",
    rates: { council: 780, water: 240, strata: 0 }, docs: "nsw", times: [[6, 600, 660], [3, 1050, 1110]] },
  { state: "NSW", suburb: "Castle Hill", postcode: "2154", type: "house", address: "12 Greenwood Close, Castle Hill NSW 2154", lat: -33.7294, lng: 151.0039, beds: 5, baths: 3, cars: 3,
    title: "Executive five-bedroom home with a pool and a theatre room", price: 2650000, amenities: ["pool", "garden", "garage", "air_conditioning", "ensuite", "study", "solar", "security"],
    intro: "A grand five-bedroom family home in a cul-de-sac. Formal and informal living, a home theatre, a gourmet kitchen, a study and a heated pool with an alfresco area. Triple garage, ducted air conditioning and solar. Close to the Metro and top schools.",
    rates: { council: 590, water: 220, strata: 0 }, docs: "nsw", times: [[6, 600, 660], [0, 570, 630]] },
  { state: "NSW", suburb: "Terrigal", postcode: "2260", type: "house", address: "7 Scenic Highway, Terrigal NSW 2260", lat: -33.4478, lng: 151.4440, beds: 6, baths: 5, cars: 4,
    title: "Waterfront estate with a pool, tennis court and six bedrooms", price: 7800000, amenities: ["pool", "garden", "garage", "air_conditioning", "ensuite", "study", "solar", "security", "balcony"],
    intro: "A private estate on an elevated 2,100 sqm block with sweeping water views. Six bedrooms each with an ensuite, a library, a wine cellar, a resort pool and a floodlit tennis court. Four-car garage with a gated drive. Offered for the first time in 30 years.",
    rates: { council: 1150, water: 310, strata: 0 }, docs: "nsw", times: [[6, 600, 660], [0, 600, 660]] },
  { state: "NSW", suburb: "Paddington", postcode: "2021", type: "house", address: "26 Gordon Street, Paddington NSW 2021", lat: -33.8850, lng: 151.2300, beds: 3, baths: 2, cars: 0,
    title: "Charming terrace in a heritage street, Paddington", price: 3150000, amenities: ["garden", "air_conditioning", "study"],
    intro: "A Victorian terrace on a tree-lined street with iron lace, high ceilings and a sandstone-paved courtyard. Three bedrooms and a study, a renovated kitchen and a bathroom added in 2021. Heritage conservation area. Street parking by permit.",
    rates: { council: 510, water: 180, strata: 0 }, docs: "nsw", times: [[6, 630, 690], [2, 1080, 1140]] },
  { state: "NSW", suburb: "Lismore", postcode: "2480", type: "house", address: "33 Keen Street, Lismore NSW 2480", lat: -28.8135, lng: 153.2770, beds: 3, baths: 1, cars: 2,
    title: "Elevated cottage on a large block, needs finishing touches", price: 520000, amenities: ["garden", "garage", "pet_friendly"],
    intro: "A classic timber cottage on high ground with a 900 sqm block. Three bedrooms, wide verandahs and a big shed. The kitchen has been renovated; the bathroom and exterior paint still need work, reflected in the price. See the flood search under the disclosures.",
    rates: { council: 305, water: 118, strata: 0 }, docs: "nsw", times: [[6, 600, 660], [0, 630, 690]] },
  { state: "VIC", suburb: "St Kilda", postcode: "3182", type: "unit", address: "5/28 Fitzroy Street, St Kilda VIC 3182", lat: -37.8600, lng: 144.9810, beds: 1, baths: 1, cars: 1,
    title: "Art deco one-bedroom apartment near the beach", price: 565000, amenities: ["balcony", "air_conditioning", "pet_friendly"],
    intro: "A character one-bedroom in a well-kept art deco block. Original parquetry floors, a sunny balcony and a lock-up garage. Trams and Fitzroy Street cafes at your door, the beach a short stroll away.",
    rates: { council: 252, water: 124, strata: 840 }, docs: "vic", times: [[6, 600, 660], [3, 1080, 1140]] },
  { state: "VIC", suburb: "Footscray", postcode: "3011", type: "unit", address: "11/75 Barkly Street, Footscray VIC 3011", lat: -37.8000, lng: 144.8990, beds: 2, baths: 1, cars: 1,
    title: "Two-bedroom apartment minutes from Footscray station", price: 480000, amenities: ["air_conditioning", "lift", "security"],
    intro: "A bright two-bedroom apartment with an open kitchen and a secure car space. Five minutes to the station, the market and Victoria University. A well-priced first home or investment in a fast-changing suburb.",
    rates: { council: 255, water: 125, strata: 810 }, docs: "vic", times: [[0, 600, 660], [6, 720, 780]] },
  { state: "VIC", suburb: "South Yarra", postcode: "3141", type: "unit", address: "14/7 Toorak Road, South Yarra VIC 3141", lat: -37.8394, lng: 144.9930, beds: 3, baths: 2, cars: 2,
    title: "Luxury three-bedroom apartment overlooking the Botanic Gardens", price: 2250000, amenities: ["balcony", "air_conditioning", "lift", "security", "pool", "ensuite"],
    intro: "A sophisticated three-bedroom apartment on a high floor with garden views. Stone kitchen, European appliances, an ensuite and walk-in robe to the main, and two car spaces. Residents enjoy a pool, gym and concierge.",
    rates: { council: 520, water: 190, strata: 2150 }, docs: "vic", times: [[6, 630, 690], [3, 1050, 1110]] },
  { state: "VIC", suburb: "Preston", postcode: "3072", type: "townhouse", address: "2/118 Gower Street, Preston VIC 3072", lat: -37.7401, lng: 145.0001, beds: 2, baths: 2, cars: 1,
    title: "Two-bedroom townhouse on a quiet street in Preston", price: 705000, amenities: ["garden", "air_conditioning", "garage"],
    intro: "A modern two-storey townhouse at the back of a block of two. Two bedrooms upstairs each with an ensuite-style bathroom access, an open living area and a low-maintenance garden. Close to the High Street tram and the Preston market.",
    rates: { council: 320, water: 140, strata: 0 }, docs: "vic", times: [[6, 600, 660], [2, 1080, 1140]] },
  { state: "VIC", suburb: "Glen Waverley", postcode: "3150", type: "townhouse", address: "5/22 Springvale Road, Glen Waverley VIC 3150", lat: -37.8780, lng: 145.1650, beds: 3, baths: 2, cars: 2,
    title: "Three-bedroom townhouse in the Glen Waverley school zone", price: 1180000, amenities: ["garage", "garden", "air_conditioning", "ensuite"],
    intro: "A stylish three-bedroom townhouse in a boutique group of five, in the zone for Glen Waverley Secondary College. Double garage with internal entry, a north-facing courtyard and ducted heating and cooling.",
    rates: { council: 405, water: 158, strata: 0 }, docs: "vic", times: [[6, 570, 630], [0, 600, 660]] },
  { state: "VIC", suburb: "Geelong", postcode: "3220", type: "house", address: "29 Pakington Street, Geelong West VIC 3218", lat: -38.1400, lng: 144.3500, beds: 3, baths: 1, cars: 1,
    title: "Californian bungalow ready for your renovation ideas", price: 735000, amenities: ["garden", "pet_friendly"],
    intro: "A sunny bungalow on a 520 sqm block, with leadlight windows, a timber porch and plenty of original charm. Three bedrooms, a big back garden and a single garage. Needs a refresh; a rare chance to add value close to Pakington Street.",
    rates: { council: 340, water: 132, strata: 0 }, docs: "vic", times: [[6, 600, 660], [3, 1050, 1110]] },
  { state: "VIC", suburb: "Ballarat", postcode: "3350", type: "house", address: "54 Lydiard Street North, Ballarat VIC 3350", lat: -37.5600, lng: 143.8600, beds: 4, baths: 2, cars: 2,
    title: "Four-bedroom family home with ducted heating", price: 595000, amenities: ["garden", "garage", "solar", "air_conditioning"],
    intro: "A comfortable four-bedroom brick home with an open-plan kitchen and family room, a separate lounge and a large rear yard. Ducted heating, solar panels and a double garage. Walk to the Ballarat Gardens and the train station.",
    rates: { council: 310, water: 118, strata: 0 }, docs: "vic", times: [[6, 600, 660], [0, 570, 630]] },
  { state: "VIC", suburb: "Brighton", postcode: "3186", type: "house", address: "16 Wolseley Grove, Brighton VIC 3186", lat: -37.9061, lng: 144.9990, beds: 5, baths: 4, cars: 3,
    title: "Grand five-bedroom Brighton residence with a pool and tennis court", price: 6200000, amenities: ["pool", "garden", "garage", "air_conditioning", "ensuite", "study", "solar", "security"],
    intro: "A magnificent five-bedroom residence on 1,050 sqm in the golden mile. Formal and casual living, a gourmet kitchen with a butler's pantry, a cinema room, a heated pool and a tennis court. Three-car garage with a gated entrance. A short walk to Church Street and Brighton Beach.",
    rates: { council: 1020, water: 285, strata: 0 }, docs: "vic", times: [[6, 600, 660], [3, 1050, 1110]] },
  { state: "VIC", suburb: "Mornington", postcode: "3931", type: "house", address: "8 Vale Street, Mornington VIC 3931", lat: -38.2180, lng: 145.0360, beds: 4, baths: 2, cars: 2,
    title: "Coastal four-bedroom villa within walking distance of the pier", price: 1650000, amenities: ["garden", "garage", "air_conditioning", "balcony", "solar"],
    intro: "A coastal villa with a wide verandah, high ceilings and a renovated kitchen opening to a north-facing deck. Four bedrooms, a double garage and a manicured garden. Walk to the Main Street cafes and the pier.",
    rates: { council: 470, water: 175, strata: 0 }, docs: "vic", times: [[6, 600, 660], [0, 600, 660]] },
  { state: "QLD", suburb: "Fortitude Valley", postcode: "4006", type: "unit", address: "1204/88 Brunswick Street, Fortitude Valley QLD 4006", lat: -27.4570, lng: 153.0370, beds: 1, baths: 1, cars: 1,
    title: "High-floor one-bedroom apartment in the Valley", price: 520000, amenities: ["balcony", "air_conditioning", "lift", "pool", "security"],
    intro: "A stylish one-bedroom apartment on the 12th floor with city views, a covered balcony and a secure car space. The building has a pool, gym and rooftop terrace. Walk to the train, restaurants and James Street.",
    rates: { council: 245, water: 128, strata: 1350 }, docs: "qld", times: [[6, 600, 660], [3, 1080, 1140]] },
  { state: "QLD", suburb: "Southport", postcode: "4215", type: "unit", address: "802/12 Marine Parade, Southport QLD 4215", lat: -27.9670, lng: 153.4140, beds: 2, baths: 2, cars: 2,
    title: "Gold Coast two-bedroom apartment with water views", price: 890000, amenities: ["balcony", "pool", "air_conditioning", "lift", "security", "ensuite"],
    intro: "A spacious two-bedroom, two-bathroom apartment with a large balcony overlooking the Broadwater. Two secure car spaces, a resort pool and a gym. Walk to Australia Fair, the tram and the beach.",
    rates: { council: 350, water: 160, strata: 1650 }, docs: "qld", times: [[6, 630, 690], [0, 600, 660]] },
  { state: "QLD", suburb: "Indooroopilly", postcode: "4068", type: "townhouse", address: "6/45 Station Road, Indooroopilly QLD 4068", lat: -27.5000, lng: 152.9730, beds: 3, baths: 2, cars: 2,
    title: "Three-bedroom townhouse close to the university and the station", price: 925000, amenities: ["garage", "air_conditioning", "garden", "balcony"],
    intro: "A well-kept townhouse in a quiet complex of nine, close to the University of Queensland, the shopping centre and the train. Three bedrooms, air conditioning in each, a double lock-up garage and a private courtyard.",
    rates: { council: 390, water: 150, strata: 700 }, docs: "qld", times: [[6, 600, 660], [2, 1080, 1140]] },
  { state: "QLD", suburb: "Carindale", postcode: "4152", type: "house", address: "20 Whitehaven Court, Carindale QLD 4152", lat: -27.5040, lng: 153.1010, beds: 4, baths: 2, cars: 2,
    title: "Low-set four-bedroom family home with a pool", price: 1090000, amenities: ["pool", "garden", "garage", "air_conditioning", "solar"],
    intro: "A low-set brick family home on a 700 sqm corner block. Four bedrooms, a big open living area flowing to a covered patio and a fenced saltwater pool. Solar panels and a double garage. Near Carindale Westfield and good schools.",
    rates: { council: 510, water: 190, strata: 0 }, docs: "qld", times: [[6, 600, 660], [0, 600, 660]] },
  { state: "QLD", suburb: "Toowoomba", postcode: "4350", type: "house", address: "15 Margaret Street, Toowoomba QLD 4350", lat: -27.5598, lng: 151.9507, beds: 3, baths: 1, cars: 1,
    title: "Original Queenslander on a large block, needs renovating", price: 465000, amenities: ["garden", "pet_friendly"],
    intro: "A classic high-set Queenslander on 810 sqm in original condition, with VJ walls and high ceilings. Three bedrooms and a sleep-out. Needs a full renovation, including wiring and plumbing checks; a great project close to the city centre.",
    rates: { council: 290, water: 110, strata: 0 }, docs: "qld", times: [[6, 600, 660], [0, 630, 690]] },
  { state: "QLD", suburb: "Noosa Heads", postcode: "4567", type: "house", address: "3 Hastings Street, Noosa Heads QLD 4567", lat: -26.3880, lng: 153.0910, beds: 5, baths: 4, cars: 3,
    title: "Luxury five-bedroom villa moments from Hastings Street", price: 5400000, amenities: ["pool", "garden", "garage", "air_conditioning", "ensuite", "study", "security", "balcony", "solar"],
    intro: "A resort-style villa on a 900 sqm block a short stroll from Noosa Main Beach. Five bedrooms each with an ensuite, a chef's kitchen, a media room and a private pool courtyard with an outdoor kitchen. Triple garage and a separate guest suite.",
    rates: { council: 980, water: 270, strata: 0 }, docs: "qld", times: [[6, 600, 660], [0, 600, 660]] },
  { state: "QLD", suburb: "Cairns", postcode: "4870", type: "house", address: "22 Esplanade, Cairns City QLD 4870", lat: -16.9220, lng: 145.7800, beds: 3, baths: 2, cars: 2,
    title: "Tropical three-bedroom home with a pool and tiled terrace", price: 780000, amenities: ["pool", "garden", "garage", "air_conditioning", "balcony"],
    intro: "A tropical home with louvred windows, a big tiled terrace and a shimmering pool in a lush garden. Three bedrooms, a renovated kitchen and a double garage. Close to the Esplanade Lagoon and the city centre.",
    rates: { council: 400, water: 180, strata: 0 }, docs: "qld", times: [[6, 570, 630], [0, 600, 660]] },
  { state: "VIC", suburb: "Hawthorn", postcode: "3122", type: "house", address: "31 Glenferrie Road, Hawthorn VIC 3122", lat: -37.8220, lng: 145.0350, beds: 4, baths: 2, cars: 2,
    title: "Federation villa with period features near Glenferrie station", price: 2480000, amenities: ["garden", "garage", "air_conditioning", "study", "solar"],
    intro: "A beautifully restored Federation villa with ornate ceilings, stained glass and polished floors. Four bedrooms and a study, a modern rear extension with a stone kitchen, a north-facing garden and a double garage via the rear lane. Walk to Glenferrie Road and the train.",
    rates: { council: 560, water: 195, strata: 0 }, docs: "vic", times: [[6, 600, 660], [3, 1050, 1110]] },
  { state: "QLD", suburb: "Nundah", postcode: "4012", type: "townhouse", address: "4/31 Buckland Road, Nundah QLD 4012", lat: -27.4000, lng: 153.0600, beds: 2, baths: 2, cars: 1,
    title: "Two-bedroom townhouse a short walk from Nundah Village", price: 640000, amenities: ["air_conditioning", "garden", "pet_friendly", "garage"],
    intro: "A low-maintenance townhouse in a group of six. Two bedrooms with built-in robes, two bathrooms, a covered patio and a small garden. Walk to Nundah Village, the train station and the cafes.",
    rates: { council: 325, water: 140, strata: 620 }, docs: "qld", times: [[6, 600, 660], [2, 1080, 1140]] }

];
const DOC_SETS = {
  nsw: [["contract", "Contract for the sale of land (with section 10.7 planning certificate)", "nsw_contract_of_sale"], ["title_search", "Title search", "title_search"],
    ["building_inspection", "Building inspection report", "building_pest_report"], ["pest_report", "Timber pest report", null]],
  vic: [["contract", "Vendor's statement (section 32) and contract of sale", "vic_section_32"], ["title_search", "Title search and plan of subdivision", "title_search"],
    ["building_inspection", "Building inspection report", "building_pest_report"], ["pest_report", "Timber pest report", null]],
  qld: [["contract", "Seller disclosure statement (Form 2) and contract", "qld_seller_disclosure_statement"], ["title_search", "Current title search", "qld_title_search"],
    ["other", "Registered survey plan", "qld_registered_plan"], ["other", "Pool safety certificate", "qld_pool_safety_sale"], ["other", "Smoke alarm compliance declaration", "qld_smoke_alarm_compliance_sale"],
    ["building_inspection", "Building inspection report", null], ["pest_report", "Timber pest report", null]]
};
const describe = e => {
  const f = e.rates, repay = loan(e.price);
  return [e.intro,
    `Rates and outgoings (approximate, per quarter): council rates ${money(f.council)}, water and sewerage ${money(f.water)}${f.strata ? `, strata levies ${money(f.strata)}` : ""}.`,
    `Finance example: with a 20% deposit (${money(Math.round(e.price * 0.2))}) and a 30-year loan at an example rate of 6.20% a year, repayments would be about ${money(repay)} a month. This is an illustration only, not an offer of credit; rates change.`,
    `Open inspections are bookable on the listing page. Sold direct by the owner, so you deal with the person who knows the property best. Demo data.`].join("\n\n");
};

async function seedOwnerExamples(client) {
  const email = `${EXAMPLE_OWNER}${D}`;
  let owner = (await client.query(`SELECT id FROM app_user WHERE email = $1`, [email])).rows[0]?.id;
  if (!owner) {
    owner = (await client.query(`INSERT INTO app_user (email, display_name, user_type, status) VALUES ($1, 'Marcus Bell (owner, 36 example listings)', 'owner', 'active') RETURNING id`, [email])).rows[0].id;
    await client.query(`INSERT INTO terms_acceptance (user_id, version) VALUES ($1, '2026-10-24')`, [owner]);
  }
  const boss = (await client.query(`SELECT id FROM app_user WHERE email = $1`, [`staff.super_admin${D}`])).rows[0]?.id;
  if (!boss) { console.log("Example listings skipped: demo staff are missing."); return; }
  let ta = (await client.query(`SELECT id FROM trust_account WHERE approved_at IS NOT NULL ORDER BY approved_at LIMIT 1`)).rows[0]?.id;
  if (!ta) {
    const firm = (await client.query(`INSERT INTO law_firm (name, jurisdiction, tier) VALUES ('Harbour Legal (demo)', 'QLD', 'registered') RETURNING id`)).rows[0].id;
    ta = (await client.query(
      `INSERT INTO trust_account (firm_id, account_name, bsb, account_number_encrypted, details_fingerprint, last_human_approved_fingerprint, approved_by, approved_at)
       VALUES ($1, 'Harbour Legal Trust (demo)', '064000', '\\x00', 'demo-fp', 'demo-fp', $2, now()) RETURNING id`, [firm, boss])).rows[0].id;
  }
  const dir = localDevStorageDir(process.env);
  const iso = days => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
  let made = 0;
  for (const [i, e] of EXAMPLES.entries()) {
    if ((await client.query(`SELECT 1 FROM property_listing WHERE owner_user_id = $1 AND address_text = $2`, [owner, e.address])).rowCount) continue;
    const cfg = (await client.query(`SELECT id FROM disclosure_config_version WHERE jurisdiction = $1 AND transaction_type = 'sale' AND use_class = 'residential' AND status = 'approved'`, [e.state])).rows[0]?.id ?? null;
    const pid = (await client.query(
      `INSERT INTO property (address_text, state, suburb, postcode, use_class, property_type, bedrooms, bathrooms, car_spaces, latitude, longitude)
       VALUES ($1, $2, $3, $4, 'residential', $5, $6, $7, $8, $9, $10) RETURNING id`, [e.address, e.state, e.suburb, e.postcode, e.type, e.beds, e.baths, e.cars, e.lat, e.lng])).rows[0].id;
    const lid = (await client.query(
      `INSERT INTO property_listing (owner_user_id, jurisdiction, transaction_type, use_class, property_type, title, description, address_text, suburb, postcode, price_cents,
         bedrooms, bathrooms, parking, amenities, latitude, longitude, property_id, status, listing_fee_paid, terms_accepted, disclosure_config_version_id, created_at)
       VALUES ($1, $2, 'sale', 'residential', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'published', true, true, $17, now() - $18::int * interval '1 day') RETURNING id`,
      [owner, e.state, e.type, e.title, describe(e), e.address, e.suburb, e.postcode, e.price * 100, e.beds, e.baths, e.cars, e.amenities, e.lat, e.lng, pid, cfg, 3 + i * 2])).rows[0].id;
    await client.query(`INSERT INTO trust_account_check (listing_id, trust_account_id, decision, evidence, reasons) VALUES ($1, $2, 'approved', '{}', '["Demo data"]')`, [lid, ta]);
    for (const [kind, name, key] of DOC_SETS[e.docs]) {
      const bytes = makePdf(name, [e.address, `State: ${e.state}`, "Example document for the demo owner. Not a real certificate or report."]);
      const id = randomUUID(), storageKey = `listings/${lid}/${randomUUID()}`;
      if (dir) await putLocalObject(dir, storageKey, bytes);
      // Contracts and disclosures are public so buyers can read them before an offer; reports are shared with parties only.
      await client.query(
        `INSERT INTO property_document (id, property_id, listing_id, kind, storage_key, sha256, uploaded_by, source, declared_mime, size_bytes, visibility, status, uploaded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'owner_supplied', 'application/pdf', $8, $9, 'active', now() - interval '2 days')`,
        [id, pid, lid, kind, storageKey, createHash("sha256").update(bytes).digest("hex"), owner, bytes.length, key ? "public" : "parties"]);
      if (key) {
        await client.query(
          `INSERT INTO listing_disclosure (listing_id, jurisdiction, disclosure_key, satisfied, evidence_reference, verified_by, verified_at, state, evidence_document_id, submitted_by, submitted_at, config_version_id)
           VALUES ($1, $2, $3, true, $4, $5, now() - interval '1 day', 'verified', $6, $7, now() - interval '2 days', $8)`, [lid, e.state, key, name, boss, id, owner, cfg]);
      }
    }
    for (const [dow, start, end] of e.times) {
      await client.query(`INSERT INTO open_inspection_availability (listing_id, created_by, recurrence, day_of_week, start_min, end_min, slot_minutes, capacity) VALUES ($1, $2, 'weekly', $3, $4, $5, 15, 2)`, [lid, owner, dow, start, end]);
    }
    await client.query(`INSERT INTO open_inspection_availability (listing_id, created_by, recurrence, on_date, start_min, end_min, slot_minutes, capacity) VALUES ($1, $2, 'once', $3, 720, 780, 30, 3)`, [lid, owner, iso(5 + i)]);
    made++;
  }
  console.log(made ? `Example listings created: ${made} for ${email}.` : `Example listings already present for ${email}.`);
}

// ---- 30 more varied listings (browse and saved-search testing) -------------------------------------------------------
// Sale and rent across all eight states, every property type, 0-6 bedrooms, so saved searches have something to filter.
// Idempotent per address. Photos and map pins come from the shared seedPhotos / listing coordinates below.
const MORE_LISTINGS = [
  // [state, suburb, postcode, street, type, sale|rent, price (AUD, weekly for rent), beds, baths, cars, lat, lng]
  ["QLD", "Bulimba", "4171", "14 Oxford St", "house", "sale", 1850000, 5, 3, 2, -27.4488, 153.0584], ["QLD", "Teneriffe", "4005", "22/9 Macquarie St", "unit", "sale", 695000, 2, 2, 1, -27.4558, 153.0463],
  ["QLD", "Ascot", "4007", "61 Lancaster Rd", "house", "rent", 1100, 4, 2, 2, -27.4300, 153.0600], ["QLD", "Southport", "4215", "7/30 Seaworld Dr", "unit", "rent", 620, 1, 1, 1, -27.9660, 153.4290],
  ["QLD", "Noosaville", "4566", "5 Gympie Tce", "townhouse", "sale", 1250000, 3, 2, 2, -26.3970, 153.0620], ["QLD", "Springfield Lakes", "4300", "18 Brookside Ct", "land", "sale", 420000, 0, 0, 0, -27.6840, 152.9060],
  ["NSW", "Manly", "2095", "12 Ocean Pde", "unit", "sale", 1480000, 2, 2, 1, -33.7970, 151.2880], ["NSW", "Parramatta", "2150", "310/8 Church St", "unit", "rent", 560, 1, 1, 0, -33.8150, 151.0010],
  ["NSW", "Newtown", "2042", "27 Camden St", "townhouse", "sale", 1690000, 3, 2, 1, -33.8970, 151.1790], ["NSW", "Penrith", "2750", "44 High St", "house", "sale", 890000, 4, 2, 2, -33.7510, 150.6940],
  ["NSW", "Newcastle", "2300", "9 Hunter St", "house", "rent", 780, 3, 1, 1, -32.9270, 151.7760], ["NSW", "Bondi Junction", "2022", "2/88 Oxford St", "unit", "rent", 850, 2, 1, 0, -33.8930, 151.2480],
  ["VIC", "Brighton", "3186", "19 Bay St", "house", "sale", 3250000, 5, 4, 3, -37.9060, 144.9960], ["VIC", "Carlton", "3053", "3/150 Lygon St", "unit", "rent", 520, 1, 1, 0, -37.7990, 144.9670],
  ["VIC", "Footscray", "3011", "41 Barkly St", "townhouse", "sale", 780000, 3, 2, 2, -37.8000, 144.8990], ["VIC", "Geelong", "3220", "6 Moorabool St", "house", "sale", 720000, 4, 2, 2, -38.1490, 144.3600],
  ["VIC", "St Kilda", "3182", "12/20 Acland St", "unit", "sale", 560000, 1, 1, 0, -37.8680, 144.9810], ["VIC", "Richmond", "3121", "88 Swan St", "house", "rent", 950, 3, 2, 1, -37.8240, 144.9990],
  ["WA", "Cottesloe", "6011", "4 Marine Pde", "house", "sale", 2950000, 5, 3, 2, -31.9950, 115.7510], ["WA", "Perth", "6000", "1204/1 Barrack Sq", "unit", "rent", 700, 2, 2, 1, -31.9570, 115.8590],
  ["WA", "Fremantle", "6160", "15 South Tce", "townhouse", "sale", 910000, 3, 2, 1, -32.0570, 115.7480], ["SA", "Glenelg", "5045", "31 Moseley St", "house", "sale", 1380000, 4, 2, 2, -34.9810, 138.5160],
  ["SA", "Adelaide", "5000", "9/60 Gouger St", "unit", "rent", 480, 1, 1, 0, -34.9290, 138.5960], ["SA", "Norwood", "5067", "23 The Parade", "house", "rent", 690, 3, 1, 1, -34.9210, 138.6330],
  ["TAS", "Sandy Bay", "7005", "17 Churchill Ave", "house", "sale", 1050000, 4, 2, 2, -42.8990, 147.3250], ["TAS", "Launceston", "7250", "5 George St", "townhouse", "rent", 560, 2, 1, 1, -41.4370, 147.1390],
  ["ACT", "Kingston", "2604", "11/3 Giles St", "unit", "sale", 640000, 2, 1, 1, -35.3150, 149.1450], ["ACT", "Gungahlin", "2912", "28 Hibberson St", "house", "rent", 720, 4, 2, 2, -35.1850, 149.1330],
  ["NT", "Darwin City", "0800", "14/2 Smith St", "unit", "rent", 520, 2, 1, 1, -12.4630, 130.8420], ["NT", "Fannie Bay", "0820", "8 Aralia St", "house", "sale", 970000, 4, 2, 2, -12.4290, 130.8350]
];
async function seedMoreListings(client) {
  const email = "more.listings@demo.invalid";
  let owner = (await client.query(`SELECT id FROM app_user WHERE email = $1`, [email])).rows[0]?.id;
  if (!owner) {
    owner = (await client.query(`INSERT INTO app_user (email, display_name, user_type, status) VALUES ($1, 'Dana Wright (owner, 30 more listings)', 'owner', 'active') RETURNING id`, [email])).rows[0].id;
    await client.query(`INSERT INTO terms_acceptance (user_id, version) VALUES ($1, '2026-10-24')`, [owner]);
  }
  const ta = (await client.query(`SELECT id FROM trust_account WHERE approved_at IS NOT NULL ORDER BY approved_at LIMIT 1`)).rows[0]?.id;
  if (!ta) { console.log("More listings skipped: no approved trust account yet."); return; }
  let made = 0;
  for (const [i, [state, suburb, postcode, street, type, tx, price, beds, baths, cars, lat, lng]] of MORE_LISTINGS.entries()) {
    const address = `${street}, ${suburb} ${state} ${postcode}`;
    if ((await client.query(`SELECT 1 FROM property_listing WHERE owner_user_id = $1 AND address_text = $2`, [owner, address])).rowCount) continue;
    const kind = type === "land" ? "Vacant block" : `${beds}-bedroom ${type}`;
    const title = `${kind.charAt(0).toUpperCase() + kind.slice(1)} in ${suburb}`;
    const pid = (await client.query(
      `INSERT INTO property (address_text, state, suburb, postcode, use_class, property_type, bedrooms, bathrooms, car_spaces, latitude, longitude)
       VALUES ($1, $2, $3, $4, 'residential', $5, $6, $7, $8, $9, $10) RETURNING id`, [address, state, suburb, postcode, type, beds, baths, cars, lat, lng])).rows[0].id;
    const lid = (await client.query(
      `INSERT INTO property_listing (owner_user_id, jurisdiction, transaction_type, use_class, property_type, title, description, address_text, suburb, postcode, price_cents,
         bedrooms, bathrooms, parking, latitude, longitude, property_id, status, listing_fee_paid, terms_accepted, created_at)
       VALUES ($1, $2, $3, 'residential', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'published', true, true, now() - $17::int * interval '1 day') RETURNING id`,
      [owner, state, tx, type, title, `Demo listing in ${suburb}. Example data for browsing and saved-search testing.`, address, suburb, postcode, price * 100, beds, baths, cars, lat, lng, pid, 1 + i])).rows[0].id;
    await client.query(`INSERT INTO trust_account_check (listing_id, trust_account_id, decision, evidence, reasons) VALUES ($1, $2, 'approved', '{}', '["Demo data"]')`, [lid, ta]);
    made++;
  }
  console.log(made ? `More listings created: ${made} for ${email}.` : `More listings already present for ${email}.`);
}

// ---- Open inspection times for the Bondi demo listing ----------------------------------------------------------------
// Published by the owner (Sarah): a weekly Saturday morning session plus a few one-off dates over the next three weeks
// (evening, morning and afternoon). Dates are relative to today in Sydney time. Idempotent: skipped once the listing has times.
async function seedInspectionTimes(client) {
  const l = (await client.query(
    `SELECT l.id, l.owner_user_id FROM property_listing l JOIN app_user u ON u.id = l.owner_user_id
      WHERE l.address_text = '45 Beach Rd, Bondi NSW 2026' AND u.email LIKE '%@demo.invalid' LIMIT 1`)).rows[0];
  if (!l || (await client.query(`SELECT 1 FROM open_inspection_availability WHERE listing_id = $1`, [l.id])).rowCount) return;
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" });
  const inDays = n => fmt.format(new Date(Date.now() + n * 86400000));
  const rule = [
    // recurrence, day_of_week, on_date, start, end, slot minutes, capacity, end_date
    ["weekly", 6, null, 600, 720, 30, 3, inDays(21)],            // Saturdays 10:00-12:00 for three weeks
    ["once", null, inDays(4), 1050, 1140, 30, 2, null],          // evening 5:30-7:00pm
    ["once", null, inDays(9), 540, 630, 30, 1, null],            // morning 9:00-10:30am
    ["once", null, inDays(13), 780, 840, 30, 2, null],           // afternoon 1:00-2:00pm
    ["once", null, inDays(17), 1020, 1080, 30, 2, null]          // evening 5:00-6:00pm
  ];
  for (const r of rule) {
    await client.query(
      `INSERT INTO open_inspection_availability (listing_id, created_by, recurrence, day_of_week, on_date, start_min, end_min, slot_minutes, capacity, end_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [l.id, l.owner_user_id, ...r]);
  }
  console.log(`Demo inspections: ${rule.length} open inspection times published for 45 Beach Rd, Bondi.`);
}

const url = process.env.DATABASE_URL;
if (process.env.NODE_ENV === "production") { console.error("Refusing to seed: NODE_ENV is production."); process.exit(2); }
if (!url) { console.error("DATABASE_URL is required."); process.exit(2); }
// Check the host pg will REALLY use, not just the URL authority: "?host=prod.example.com" (or PGHOST when the URL has none) overrides it.
let host = "";
try { host = String(new pg.Client({ connectionString: url }).connectionParameters.host ?? "").toLowerCase(); } catch { /* handled below */ }
if (host !== "localhost" && host !== "127.0.0.1") { console.error(`Refusing to seed: database host "${host}" is not localhost or 127.0.0.1.`); process.exit(2); }

const D = "@demo.invalid";

// Demo investor (investors are buyer accounts holding the investor role, see src/domain/roles.ts). Idempotent so an already-seeded DB gets it too.
async function seedInvestor(db) {
  const email = `noah.investor${D}`;
  let id = (await db.query(`SELECT id FROM app_user WHERE email = $1`, [email])).rows[0]?.id;
  if (!id) {
    id = (await db.query(
      `INSERT INTO app_user (email, display_name, user_type, status, roles, active_role) VALUES ($1, 'Noah Patel (investor)', 'buyer', 'active', ARRAY['buyer','investor'], 'investor') RETURNING id`, [email])).rows[0].id;
    await db.query(`INSERT INTO terms_acceptance (user_id, version) VALUES ($1, '2026-10-24')`, [id]);
    await db.query(`INSERT INTO buyer_verification (user_id, email_verified_at, phone_verified_at, phone_e164, id_verified_at, id_method)
                    VALUES ($1, now(), now(), '+61400000002', now(), 'manual_review')`, [id]);
    console.log("Demo investor created: Noah Patel (fully verified).");
  }
  // The investor declaration is what the project pages check; without a row for the CURRENT disclosure version every project shows "not found" (older rows such as 'local-demo' do not count). Added for already-seeded DBs too.
  const added = await db.query(`INSERT INTO investor_declaration (user_id, category, ack_not_advice, ack_not_offer, ack_no_funds_held, ack_off_platform, disclosure_version)
             SELECT $1, 'wholesale', true, true, true, true, $2 WHERE NOT EXISTS (SELECT 1 FROM investor_declaration WHERE user_id = $1 AND disclosure_version = $2)`, [id, DISCLOSURE_VERSION]);
  if (added.rowCount) console.log("Demo investor declaration added for Noah Patel (wholesale).");
  // Other demo investors (Grace, Hugo) were seeded with an old 'local-demo' version; give them a current one too.
  const more = await db.query(`INSERT INTO investor_declaration (user_id, category, ack_not_advice, ack_not_offer, ack_no_funds_held, ack_off_platform, disclosure_version)
             SELECT u.id, 'wholesale', true, true, true, true, $1 FROM app_user u WHERE u.email LIKE '%.investor${D}'
             AND NOT EXISTS (SELECT 1 FROM investor_declaration d WHERE d.user_id = u.id AND d.disclosure_version = $1)`, [DISCLOSURE_VERSION]);
  if (more.rowCount) console.log(`Demo investor declarations added for ${more.rowCount} more demo investor(s).`);
}
// ---- Demo agent performance + sale conversations (Messages page, Agent performance page) ------------------------------
// Idempotent (marker: priya.agent). Adds three listed agents, 13 past sales from the last 6 months (two fell through) with buyer
// ratings, and five settlements with message threads so every role has a populated inbox. Needs the base demo accounts.
async function seedPerformanceAndMessages(client) {
  const marker = await client.query(`SELECT 1 FROM app_user WHERE email = $1`, [`priya.agent${D}`]);
  if (marker.rows.length) return;
  const find = async email => (await client.query(`SELECT id FROM app_user WHERE email = $1`, [email + D])).rows[0]?.id;
  const who = { sarah: await find("sarah.owner"), daniel: await find("daniel.owner"), mia: await find("mia.agent"), james: await find("james.buyer"),
    emma: await find("emma.buyer"), liam: await find("liam.buyer"), noah: await find("noah.investor"), boss: await find("staff.super_admin") };
  if (Object.values(who).some(v => !v)) { console.log("Demo performance and messages skipped: base demo accounts are missing."); return; }
  await client.query("BEGIN");
  try {
    const q = async (text, params) => (await client.query(text, params)).rows;
    // Listed agents (Mia already exists).
    const agentSpecs = [
      ["priya", "Priya Sharma (agent)", "NSW", "Inner-west and eastern suburbs specialist", ["Apartments", "Terraces"], ["Coogee", "Marrickville", "Newtown", "Surry Hills", "Manly"], 9],
      ["tom", "Tom Becker (agent)", "VIC", "Period homes across Melbourne's inner north", ["Period homes", "First home buyers"], ["Brunswick", "Northcote", "Richmond", "Carlton"], 6],
      ["hannah", "Hannah Cole (agent)", "QLD", "New to the platform, taking new clients", ["Townhouses", "Investors"], ["Chermside", "Nundah", "Clayfield"], 3]
    ];
    for (const [key, name, st, headline, specialties, suburbs, years] of agentSpecs) {
      who[key] = (await q(`INSERT INTO app_user (email, display_name, user_type, status, roles, active_role) VALUES ($1, $2, 'agent', 'active', ARRAY['agent'], 'agent') RETURNING id`, [`${key}.agent${D}`, name]))[0].id;
      await q(`INSERT INTO terms_acceptance (user_id, version) VALUES ($1, '2026-10-24')`, [who[key]]);
      await q(`INSERT INTO agent_licence (user_id, jurisdiction, licence_number, status, verified_by, verified_at, expires_at) VALUES ($1, $2, $3, 'verified', $4, now(), (now() + interval '1 year')::date)`, [who[key], st, `DEMO-${key.toUpperCase()}-1`, who.boss]);
      await q(`INSERT INTO agent_profile (user_id, accepting_new, service_suburbs, transaction_types, use_classes, bio, listed, headline, specialties, languages, years_experience, consult_modes, consult_minutes)
               VALUES ($1, true, $2, ARRAY['sale'], ARRAY['residential'], $3, true, $4, $5, ARRAY['English'], $6, ARRAY['video','phone'], 30)`,
        [who[key], suburbs, "Demo agent profile.", headline, specialties, years]);
    }
    await q(`INSERT INTO agent_profile (user_id, accepting_new, service_suburbs, transaction_types, use_classes, bio, listed, headline, specialties, languages, years_experience, consult_modes, consult_minutes)
             VALUES ($1, true, ARRAY['Paddington','Bulimba','Ascot','Teneriffe'], ARRAY['sale'], ARRAY['residential'], 'Demo agent profile.', true, 'Inner-Brisbane family homes and townhouses', ARRAY['Family homes','Townhouses'], ARRAY['English','Mandarin'], 12, ARRAY['video','phone'], 30)
             ON CONFLICT (user_id) DO UPDATE SET listed = true, headline = EXCLUDED.headline, specialties = EXCLUDED.specialties, service_suburbs = EXCLUDED.service_suburbs, years_experience = EXCLUDED.years_experience`, [who.mia]);

    const ta = (await q(`SELECT id FROM trust_account WHERE account_name LIKE 'Harbour Legal Trust%' LIMIT 1`))[0]?.id;
    // [key, agent, owner, buyer, title, address, state, type, suburb, postcode, list $, offer $, days on market, offer days ago, status, rating, comment]
    const deals = [
      ["m1", "mia", "sarah", "james", "Queenslander with wraparound verandah", "31 Latrobe Tce, Paddington QLD 4064", "QLD", "house", "Paddington", "4064", 1420000, 1455000, 21, 20, "accepted", 5, "Mia kept us informed every step and got a great price."],
      ["m2", "mia", "daniel", "emma", "Bulimba riverside townhouse", "5/18 Oxford St, Bulimba QLD 4171", "QLD", "townhouse", "Bulimba", "4171", 980000, 960000, 34, 55, "accepted", 4, "Professional and responsive. Inspection times were flexible."],
      ["m3", "mia", "sarah", "liam", "Ascot family home", "77 Hawthorne Rd, Ascot QLD 4007", "QLD", "house", "Ascot", "4007", 1850000, 1890000, 18, 95, "accepted", 5, "Fast sale, well above what we expected."],
      ["m4", "mia", "daniel", "emma", "Teneriffe warehouse apartment", "12/40 Commercial Rd, Teneriffe QLD 4005", "QLD", "unit", "Teneriffe", "4005", 890000, 865000, 52, 130, "fallen_through", null, ""],
      ["p1", "priya", "sarah", "james", "Coogee two-bedroom with ocean glimpses", "9/14 Dolphin St, Coogee NSW 2034", "NSW", "unit", "Coogee", "2034", 1100000, 1180000, 14, 12, "accepted", 5, "Priya ran a very tight campaign and the result beat our hopes."],
      ["p2", "priya", "daniel", "noah", "Marrickville terrace, investment grade", "22 Illawarra Rd, Marrickville NSW 2204", "NSW", "house", "Marrickville", "2204", 1650000, 1620000, 29, 40, "accepted", 5, "Clear advice on rental yield and a smooth contract."],
      ["p3", "priya", "sarah", "liam", "Newtown semi-detached", "8 Bedford St, Newtown NSW 2042", "NSW", "house", "Newtown", "2042", 1420000, 1390000, 41, 75, "accepted", 4, "Good communication throughout."],
      ["p4", "priya", "daniel", "james", "Surry Hills loft apartment", "3/90 Crown St, Surry Hills NSW 2010", "NSW", "unit", "Surry Hills", "2010", 1280000, 1310000, 19, 110, "accepted", 5, "Excellent. Offer, exchange and settlement all on schedule."],
      ["p5", "priya", "sarah", "emma", "Manly apartment near the Corso", "6/33 The Corso, Manly NSW 2095", "NSW", "unit", "Manly", "2095", 1350000, 1280000, 63, 150, "accepted", 4, "Took a while, but Priya stayed realistic and patient."],
      ["t1", "tom", "daniel", "james", "Brunswick workers cottage", "14 Albert St, Brunswick VIC 3056", "VIC", "house", "Brunswick", "3056", 1050000, 1020000, 47, 30, "accepted", 3, "Fine overall, but communication was slow at times."],
      ["t2", "tom", "sarah", "emma", "Northcote period home", "61 High St, Northcote VIC 3070", "VIC", "house", "Northcote", "3070", 1480000, 1460000, 58, 88, "accepted", 4, "Knows the area well and was easy to deal with."],
      ["t3", "tom", "daniel", "liam", "Richmond one-bedroom unit", "11/200 Bridge Rd, Richmond VIC 3121", "VIC", "unit", "Richmond", "3121", 720000, 700000, 70, 120, "fallen_through", null, ""],
      ["t4", "tom", "sarah", "liam", "Carlton terrace", "27 Rathdowne St, Carlton VIC 3053", "VIC", "house", "Carlton", "3053", 1600000, 1580000, 39, 160, "accepted", 3, "Okay result, though some updates came late."]
    ];
    const deal = {};
    for (const [key, agent, owner, buyer, title, address, st, type, suburb, postcode, listD, offerD, dom, ago, status, rating, comment] of deals) {
      const listedAt = `now() - ($1::int + $2::int) * interval '1 day'`;
      const lid = (await q(
        `INSERT INTO property_listing (owner_user_id, jurisdiction, transaction_type, use_class, property_type, title, address_text, suburb, postcode, price_cents, bedrooms, bathrooms, parking, status, listing_fee_paid, terms_accepted, created_at)
         VALUES ($3, $4, 'sale', 'residential', $5, $6, $7, $8, $9, $10, 3, 2, 1, 'published', true, true, ${listedAt}) RETURNING id`,
        [ago, dom, who[owner], st, type, title, address, suburb, postcode, listD * 100]))[0].id;
      await q(`INSERT INTO listing_agent_appointment (listing_id, agent_user_id, appointed_by, appointed_at) VALUES ($1, $2, $3, now() - ($4::int + $5::int) * interval '1 day')`, [lid, who[agent], who[owner], ago, dom]);
      if (ta) await q(`INSERT INTO trust_account_check (listing_id, trust_account_id, decision, evidence, reasons) VALUES ($1, $2, 'approved', '{}', '["Demo data"]')`, [lid, ta]);
      const hash = randomBytes(32).toString("hex");
      await q(`INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at, used_at) VALUES ($1, $2, $3, now() + interval '7 days', now() - $4::int * interval '1 day')`, [hash, lid, who[buyer], ago]);
      const oid = (await q(
        `INSERT INTO formal_offer (listing_id, buyer_user_id, price_cents, conditions, settlement_days, deposit_cents, confirmed_final, link_token_hash, status, submitted_at)
         VALUES ($1, $2, $3, '["Subject to finance","Subject to building and pest inspection"]'::jsonb, 42, $4, true, $5, $6, now() - $7::int * interval '1 day') RETURNING id`,
        [lid, who[buyer], offerD * 100, Math.round(offerD * 10), hash, status, ago]))[0].id;
      await q(`INSERT INTO offer_event (offer_id, event_type, actor_kind, actor_user_id, price_cents, settlement_days, occurred_at) VALUES ($1, 'submitted', 'buyer', $2, $3, 42, now() - $4::int * interval '1 day')`, [oid, who[buyer], offerD * 100, ago]);
      await q(`INSERT INTO offer_event (offer_id, event_type, actor_kind, actor_user_id, occurred_at) VALUES ($1, 'accepted', 'owner', $2, now() - $3::int * interval '1 day' + interval '6 hours')`, [oid, who[owner], ago]);
      if (rating) await q(`INSERT INTO agent_ratings (agent_id, listing_id, buyer_id, rating, comment, created_at) VALUES ($1, $2, $3, $4, $5, now() - ($6::int - 3) * interval '1 day')`, [who[agent], lid, who[buyer], rating, comment, Math.max(ago, 4)]);
      deal[key] = { lid, oid, agent, owner, buyer, st, ago };
    }

    // Settlements with conversations: key, stage reached, [sender|null, type, hours ago, text], participants left fully unread.
    const STAGES = ["offer_accepted", "deposit_received", "cooling_off_expires", "inspection_completed", "finance_approval", "lawyer_exchange", "settlement_scheduled", "settlement_completed"];
    const threads = [
      ["m1", "inspection_completed", [], [
        [null, "system", 19 * 24, "Settlement tracker started for 31 Latrobe Tce, Paddington."],
        ["mia", "text", 19 * 24 - 1, "Hi Sarah and James, congratulations on the accepted offer at $1,455,000. I will keep this thread updated as each step is completed."],
        ["james", "text", 18 * 24, "Thanks Mia. The $145,500 deposit has gone across to the trust account this morning. Can you confirm it arrived?"],
        ["mia", "text", 18 * 24 - 3, "Confirmed, the trust account shows the deposit received. I have ticked it off on the tracker."],
        [null, "system", 18 * 24 - 4, "Settlement stage advanced: Offer accepted → Deposit received"],
        ["sarah", "text", 14 * 24, "Mia, the buyer's inspector is coming Thursday at 9am. I will leave the side gate unlocked and make sure the pool fence certificate is on the kitchen bench."],
        ["mia", "mention", 14 * 24 - 2, "@seller thank you, I will meet the inspector there. @buyer you are welcome to attend the walkthrough from 9:30am."],
        ["james", "text", 7 * 24, "The building and pest report is in. Only minor items: two loose roof tiles and some termite damage to the rear deck rail. I am happy to proceed with no price change."],
        ["sarah", "text", 7 * 24 - 5, "That is good news. I will have a handyman look at the tiles before settlement."],
        [null, "system", 7 * 24 - 6, "Settlement stage advanced: Cooling-off expires → Inspection completed"],
        ["mia", "mention", 26, "@buyer next up is finance approval. Has your broker received the valuation yet?"],
        ["james", "text", 3, "Valuation came back at $1,460,000 so we are comfortable. Unconditional approval should land by Friday."]
      ]],
      ["p1", "deposit_received", ["james"], [
        [null, "system", 11 * 24, "Settlement tracker started for 9/14 Dolphin St, Coogee."],
        ["priya", "text", 11 * 24 - 1, "Hi Sarah and James, I am Priya and will coordinate the settlement. The contract was sent to both solicitors today."],
        ["james", "text", 10 * 24, "Thanks Priya. Could you send the strata report and the last two years of body corporate minutes?"],
        ["priya", "text", 10 * 24 - 4, "Sending both now. The special levy for the roof was paid in full in March, so there are no outstanding charges on the lot."],
        ["sarah", "text", 6 * 24, "Priya, just confirming the washing machine and the blinds are included in the sale as per the contract."],
        ["priya", "mention", 6 * 24 - 2, "@seller yes, both are listed as inclusions on page 3. @buyer a final walkthrough can be booked the week before settlement."],
        ["james", "text", 2 * 24, "Deposit has been paid. Please can you check the receipt came through."],
        [null, "system", 2 * 24 - 1, "Settlement stage advanced: Offer accepted → Deposit received"]
      ]],
      ["m2", "finance_approval", ["emma"], [
        [null, "system", 50 * 24, "Settlement tracker started for 5/18 Oxford St, Bulimba."],
        ["mia", "text", 50 * 24 - 1, "Hi Daniel and Emma, welcome to the settlement thread for the Bulimba townhouse. I will post key dates here."],
        ["emma", "text", 45 * 24, "Hi Mia, our broker needs the body corporate insurance certificate for the lender. Can you get a copy?"],
        ["daniel", "text", 45 * 24 - 6, "I have attached the certificate to the document checklist. It runs until 30 June next year."],
        ["mia", "text", 30 * 24, "The lender's valuer visits on Tuesday at 11am. Daniel, can the townhouse be left accessible?"],
        ["daniel", "text", 30 * 24 - 2, "Yes, I will be at work but the lockbox code is with you."],
        ["emma", "text", 8 * 24, "Finance is approved subject to the valuation, which came in at $965,000. Thank you all."],
        [null, "system", 8 * 24 - 1, "Settlement stage advanced: Inspection completed → Finance approval"],
        ["mia", "mention", 5, "@seller @buyer both solicitors have the final contract. Exchange is booked for Monday afternoon."]
      ]],
      ["t1", "settlement_scheduled", ["james"], [
        [null, "system", 28 * 24, "Settlement tracker started for 14 Albert St, Brunswick."],
        ["tom", "text", 27 * 24, "Hi Daniel and James. Your solicitors have the contract. I will track the dates below."],
        ["james", "text", 20 * 24, "Tom, our solicitor raised a query about the fence on the eastern boundary. Do you have a survey?"],
        ["daniel", "text", 20 * 24 - 8, "The boundary was surveyed in 2019. I have uploaded the survey plan to documents."],
        [null, "system", 9 * 24, "Settlement stage advanced: Finance approval → Lawyer exchange"],
        ["tom", "mention", 4 * 24, "@seller @buyer contracts are exchanged. Settlement is set for 11am on the 18th at the solicitors' office."],
        ["james", "text", 4 * 24 - 3, "Perfect, we will book the removalists for the 19th."],
        [null, "system", 4 * 24 - 4, "Settlement stage advanced: Lawyer exchange → Settlement scheduled"],
        ["tom", "text", 6, "Reminder: please arrange building insurance from the settlement date. Let me know if you need a recommended provider."]
      ]],
      ["p2", "cooling_off_expires", ["noah"], [
        [null, "system", 38 * 24, "Settlement tracker started for 22 Illawarra Rd, Marrickville."],
        ["priya", "text", 38 * 24 - 1, "Hi Noah and Daniel. Congratulations on agreeing terms at $1,620,000. I will keep project updates and the settlement timeline here."],
        ["noah", "text", 37 * 24, "Thanks Priya. As this is for my investment portfolio, can I get the current lease and rent ledger?"],
        ["daniel", "text", 37 * 24 - 5, "The tenant is on a lease until March at $780 a week. I have uploaded the lease and 12 months of rent ledger."],
        ["noah", "text", 30 * 24, "Rent ledger looks clean. I will ask my property manager to take over the tenancy on settlement."],
        ["priya", "mention", 21 * 24, "@seller the buyer's accountant has asked for a depreciation schedule if one exists. @buyer cooling-off expires on Friday at 5pm."],
        ["daniel", "text", 21 * 24 - 7, "I do not have one, sorry. The last renovation was in 2022 and the invoices are in the documents folder."],
        ["noah", "text", 28, "Thanks both. I will not exercise cooling-off. Please send the transfer forms when ready."]
      ]]
    ];
    for (const [key, stage, fresh, msgs] of threads) {
      const d = deal[key];
      const sid = randomUUID();
      await q(`INSERT INTO settlement_timeline (id, offer_id, listing_id, buyer_id, seller_id, agent_id, state, current_stage, stage_entered_at, created_by, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() - interval '1 day', $5, now() - $9::int * interval '1 day')`, [sid, d.oid, d.lid, who[d.buyer], who[d.owner], who[d.agent], d.st, stage, d.ago]);
      const reached = STAGES.indexOf(stage);
      for (const [i, s] of STAGES.entries()) {
        const done = i < reached || i === 0;
        await q(`INSERT INTO settlement_milestones (settlement_id, stage, target_date, actual_date, status)
                 VALUES ($1, $2, (now() + $3::int * interval '1 day')::date, CASE WHEN $5 = 'completed' THEN (now() - $4::int * interval '1 day')::date END, $5)`,
          [sid, s, (i - reached) * 7, Math.max(d.ago - i * 3, 1), done ? "completed" : "pending"]);
      }
      await q(`INSERT INTO message_threads (id, kind, settlement_id) VALUES ($1, 'transaction', $1)`, [sid]);
      for (const [from, type, hrs, body] of msgs) {
        const sender = from ? who[from] : null;
        const mentions = type === "mention" ? [...body.matchAll(/@(buyer|seller|agent)\b/g)].map(m => m[1]).filter((v, i, a) => a.indexOf(v) === i) : [];
        await q(`INSERT INTO transaction_messages (thread_id, sender_id, message_type, body, mentions, created_at) VALUES ($1, $2, $3, $4, $5, now() - $6::int * interval '1 hour')`, [sid, sender, type, body, mentions, hrs]);
      }
      // Everyone has read up to the last message not written by them, except the second-to-last: one unread each unless listed in `fresh`.
      for (const person of [d.owner, d.buyer, d.agent]) {
        const read = fresh.includes(person) ? "'epoch'" : `(SELECT COALESCE(max(created_at), 'epoch') - interval '1 minute' FROM transaction_messages WHERE thread_id = $1 AND sender_id IS DISTINCT FROM $2)`;
        await q(`INSERT INTO message_participants (thread_id, user_id, last_read_at) VALUES ($1, $2, ${read})`, [sid, who[person]]);
      }
    }
    await client.query("COMMIT");
    console.log("Demo agent performance and messages created: 3 agents, 13 sales (2 fell through), 11 ratings, 5 conversations.");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  }
}

const db = new pg.Client({ connectionString: url });
await db.connect();
try {
  const exists = await db.query(`SELECT 1 FROM app_user WHERE email = $1`, [`sarah.owner${D}`]);
  if (exists.rows.length) {
    console.log("Demo data already present. (Use local-reset to start again.)");
    await seedInvestor(db);
    await seedPerformanceAndMessages(db);
    await seedOwnerExamples(db);
    await seedMoreListings(db);
    await seedDescriptions(db);
    await seedPhotos(db);
    await seedLocations(db);
    await seedFiles(db);
    await seedDisclosuresAndPublicDocs(db);
    await seedLeads(db);
    await seedMedia(db);
    await seedAdminExamples(db);
    await seedProject(db);
    await seedProjectDocuments(db);
    await db.end();
    process.exit(0);
  }
  await db.query("BEGIN");
  const q = async (text, params) => (await db.query(text, params)).rows;
  const user = async (type, name, email, extra = {}) =>
    (await q(`INSERT INTO app_user (email, display_name, user_type, status) VALUES ($1, $2, $3, 'active') RETURNING id`, [email + D, name, type]))[0].id;

  // Staff: one account per role, each with an accepted invite (the dev sign-in and /staff read the role from staff_invite).
  const staff = {};
  for (const [role, name] of [["super_admin", "Priya Raman"], ["compliance", "Chris Compliance"], ["accountant", "Alex Accountant"],
    ["support", "Sam Support"], ["technical", "Taylor Technical"], ["reporting", "Robin Reporting"]]) {
    const email = `staff.${role}`;
    staff[role] = await user("admin", `${name} (${role})`, email);
    await q(`INSERT INTO staff_invite (email, role, accepted_at) VALUES ($1, $2, now())`, [email + D, role]);
  }
  const boss = staff.super_admin;
  // Local demo only: investor projects module on (the live site stays off until counsel confirms in /staff/investments/settings).
  await q(`INSERT INTO investment_setting (key, enabled, updated_by) VALUES ('investment_module_enabled', true, $1)`, [boss]);
  await q(`INSERT INTO investment_setting_history (enabled, counsel_confirmed, disclosure_version, changed_by) VALUES (true, true, 'local-demo', $1)`, [boss]);

  // Users.
  const ownerA = await user("owner", "Sarah Mitchell", "sarah.owner");
  const ownerB = await user("owner", "Daniel Okafor", "daniel.owner");
  const agent = await user("agent", "Mia Chen (agent)", "mia.agent");
  const buyerVerified = await user("buyer", "James Nguyen (fully verified)", "james.buyer");
  const buyerEmail = await user("buyer", "Emma Wilson (email only)", "emma.buyer");
  const buyerNone = await user("buyer", "Liam Brown (unverified)", "liam.buyer");

  // Terms accepted by everyone who needs them.
  for (const id of [ownerA, ownerB, agent, buyerVerified, buyerEmail, buyerNone]) {
    await q(`INSERT INTO terms_acceptance (user_id, version) VALUES ($1, '2026-10-24')`, [id]);
  }

  // Agent licence (verified by a staff member) and buyer verification states.
  await q(`INSERT INTO agent_licence (user_id, jurisdiction, licence_number, status, verified_by, verified_at, expires_at)
           VALUES ($1, 'QLD', 'DEMO-1234567', 'verified', $2, now(), (now() + interval '1 year')::date)`, [agent, boss]);
  await q(`INSERT INTO buyer_verification (user_id, email_verified_at, phone_verified_at, phone_e164, id_verified_at, id_method)
           VALUES ($1, now(), now(), '+61400000001', now(), 'manual_review')`, [buyerVerified]);
  await q(`INSERT INTO buyer_verification (user_id, email_verified_at) VALUES ($1, now())`, [buyerEmail]);

  // Eight published listings: sale and rent, three states, two owners.
  const L = [
    [ownerA, "Renovated family home with pool", "12 Jacaranda St, Paddington QLD 4064", "QLD", "sale", "house", "Paddington", "4064", 169500000, 4, 2, 2],
    [ownerA, "Light-filled apartment near the river", "8/21 Moray St, New Farm QLD 4005", "QLD", "rent", "unit", "New Farm", "4005", 78000, 2, 1, 1],
    [ownerA, "Federation cottage, walk to the beach", "45 Beach Rd, Bondi NSW 2026", "NSW", "sale", "house", "Bondi", "2026", 325000000, 3, 2, 1],
    [ownerA, "Modern townhouse with courtyard", "3/17 Darley Rd, Randwick NSW 2031", "NSW", "rent", "townhouse", "Randwick", "2031", 95000, 3, 2, 2],
    [ownerB, "Period home on a quiet tree-lined street", "28 Station St, Fitzroy North VIC 3068", "VIC", "sale", "house", "Fitzroy North", "3068", 215000000, 3, 1, 0],
    [ownerB, "Sunny two-bedroom unit, close to trams", "6/102 Chapel St, Windsor VIC 3181", "VIC", "rent", "unit", "Windsor", "3181", 62000, 2, 1, 1],
    [ownerB, "Low-maintenance townhouse near the park", "9/4 Park Ave, Chermside QLD 4032", "QLD", "sale", "townhouse", "Chermside", "4032", 82500000, 3, 2, 2],
    [ownerB, "Compact studio, close to the CBD", "14/50 Kent St, Sydney NSW 2000", "NSW", "rent", "unit", "Sydney", "2000", 58000, 1, 1, 0]
  ];
  const listing = [];
  for (const l of L) {
    listing.push((await q(
      `INSERT INTO property_listing (owner_user_id, jurisdiction, transaction_type, use_class, property_type, title, address_text, suburb, postcode, price_cents, bedrooms, bathrooms, parking, status, listing_fee_paid, terms_accepted)
       VALUES ($1, $4, $5, 'residential', $6, $2, $3, $7, $8, $9, $10, $11, $12, 'published', true, true) RETURNING id`,
      [l[0], l[1], l[2], l[3], l[4], l[5], l[6], l[7], l[8], l[9], l[10], l[11]]))[0].id);
  }
  await q(`INSERT INTO listing_agent_appointment (listing_id, agent_user_id, appointed_by) VALUES ($1, $2, $3)`, [listing[0], agent, ownerA]);

  // Law firm and an approved trust account; every listing has an approved trust check (nothing publishes without one).
  const firm = (await q(`INSERT INTO law_firm (name, jurisdiction, tier) VALUES ('Harbour Legal (demo)', 'QLD', 'registered') RETURNING id`))[0].id;
  const ta = (await q(
    `INSERT INTO trust_account (firm_id, account_name, bsb, account_number_encrypted, details_fingerprint, last_human_approved_fingerprint, approved_by, approved_at)
     VALUES ($1, 'Harbour Legal Trust (demo)', '064000', '\\x00', 'demo-fp', 'demo-fp', $2, now()) RETURNING id`, [firm, boss]))[0].id;
  for (const id of listing) {
    await q(`INSERT INTO trust_account_check (listing_id, trust_account_id, decision, evidence, reasons) VALUES ($1, $2, 'approved', '{}', '["Demo data"]')`, [id, ta]);
  }

  // Staff-verified disclosures on two listings, so the property page shows them. The keys are illustrative demo data,
  // not a statement of what a state requires (that comes from compliance configuration).
  for (const [i, key, j] of [[0, "qld_seller_disclosure_statement", "QLD"], [0, "pool_safety_certificate", "QLD"], [4, "vic_section_32", "VIC"]]) {
    await q(`INSERT INTO listing_disclosure (listing_id, jurisdiction, disclosure_key, satisfied, evidence_reference, verified_by, verified_at, state)
             VALUES ($1, $2, $3, true, 'demo-evidence', $4, now(), 'verified')`, [listing[i], j, key, boss]);
  }

  // Plan and add-on prices (the plans themselves come from the migrations).
  for (const [plan, cents] of [["basic", 0], ["standard", 14900], ["premium", 29900]]) {
    await q(`INSERT INTO plan_price (plan_id, price_cents, set_by, reason) VALUES ($1, $2, $3, 'Demo price')`, [plan, cents, boss]);
  }
  for (const [feature, cents] of [["video", 4900], ["photo_360", 5900], ["video_360", 9900], ["ai_description", 1900], ["ai_auto_reply", 2900], ["ai_applicant_report", 3900], ["contract_drafting", 7900]]) {
    await q(`INSERT INTO add_on_price (feature, price_cents, set_by, reason) VALUES ($1, $2, $3, 'Demo price')`, [feature, cents, boss]);
  }

  // Invoices: one paid, one pending.
  await q(`INSERT INTO invoice (owner_user_id, amount_ex_gst_cents, gst_cents, total_cents, status, provider, provider_ref, paid_at, listing_id, plan_id)
           VALUES ($1, 13545, 1355, 14900, 'paid', 'demo', 'demo-paid-1', now(), $2, 'standard')`, [ownerA, listing[0]]);
  await q(`INSERT INTO invoice (owner_user_id, amount_ex_gst_cents, gst_cents, total_cents, status, listing_id, plan_id)
           VALUES ($1, 27182, 2718, 29900, 'pending', $2, 'premium')`, [ownerB, listing[4]]);

  // Enquiries with messages; one open offer-link request for the owner to answer.
  const enquiry = async (lid, buyer) => (await q(`INSERT INTO enquiry (listing_id, buyer_user_id) VALUES ($1, $2) RETURNING id`, [lid, buyer]))[0].id;
  const msg = (eid, sender, body, min) => q(`INSERT INTO enquiry_message (enquiry_id, sender_user_id, body, sent_at) VALUES ($1, $2, $3, now() - ($4 || ' minutes')::interval)`, [eid, sender, body, String(min)]);
  const e1 = await enquiry(listing[0], buyerVerified);
  await msg(e1, buyerVerified, "Hi Sarah, is the Paddington home still available? Could I inspect on Saturday morning?", 90);
  await msg(e1, ownerA, "Hi James, yes it is. Inspections are Saturday 10:00-10:30am.", 60);
  await msg(e1, buyerVerified, "Great, thanks. See you then.", 30);
  const e2 = await enquiry(listing[4], buyerVerified);
  await msg(e2, buyerVerified, "Hello Daniel, I would like to make a formal offer on the Fitzroy North house. Please send me the offer link.", 20);
  await q(`INSERT INTO offer_link_request (enquiry_id) VALUES ($1)`, [e2]);
  const e3 = await enquiry(listing[2], buyerEmail);
  await msg(e3, buyerEmail, "Hi, is the Bondi cottage open for inspection this week?", 15);

  // Two submitted formal offers (single-use links already spent) on Sarah's sale listings.
  // Paddington has an earlier offer the owner asked James to improve (offer history and timeline on the offer page).
  for (const [lid, price, deposit, days, ago, status] of [[listing[0], 160000000, 16000000, 42, "3 days", "countered"], [listing[0], 165000000, 16500000, 42, "1 day", "submitted"], [listing[2], 318000000, 31800000, 60, "1 day", "submitted"]]) {
    const hash = randomBytes(32).toString("hex");
    await q(`INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at, used_at) VALUES ($1, $2, $3, now() + interval '7 days', now() - $4::interval)`, [hash, lid, buyerVerified, ago]);
    const [o] = await q(`INSERT INTO formal_offer (listing_id, buyer_user_id, price_cents, conditions, settlement_days, deposit_cents, confirmed_final, link_token_hash, status, submitted_at)
             VALUES ($1, $2, $3, '["Subject to finance","Subject to building and pest inspection"]'::jsonb, $5, $4, true, $6, $7, now() - $8::interval) RETURNING id, submitted_at`, [lid, buyerVerified, price, deposit, days, hash, status, ago]);
    await q(`INSERT INTO offer_event (offer_id, event_type, actor_kind, actor_user_id, price_cents, settlement_days, occurred_at) VALUES ($1, 'submitted', 'buyer', $2, $3, $4, $5)`, [o.id, buyerVerified, price, days, o.submitted_at]);
    if (status === "countered") await q(`INSERT INTO offer_event (offer_id, event_type, actor_kind, actor_user_id, occurred_at) VALUES ($1, 'countered', 'owner', $2, $3::timestamptz + interval '5 hours')`, [o.id, ownerA, o.submitted_at]);
  }

  // ID review queue: two buyers waiting for staff review (no images locally: storage is off).
  for (const [uid, kind] of [[buyerEmail, "drivers_licence"], [buyerNone, "passport"]]) {
    await q(`INSERT INTO id_submission (user_id, document_kind, document_country, expiry_date, selfie_captured_in_app) VALUES ($1, $2, 'AU', (now() + interval '2 years')::date, true)`, [uid, kind]);
  }
  await db.query("COMMIT");
  console.log(`Demo data created: 6 staff, 2 owners, 1 agent, 3 buyers, ${listing.length} listings, 3 enquiries, 3 offers, 2 invoices, 2 ID reviews. (run ${randomUUID().slice(0, 8)})`);
  await seedInvestor(db);
  await seedPerformanceAndMessages(db);
  await seedOwnerExamples(db);
  await seedMoreListings(db);
  await seedDescriptions(db);
  await seedPhotos(db);
  await seedLocations(db);
  await seedFiles(db);
  await seedDisclosuresAndPublicDocs(db);
  await seedLeads(db);
  await seedMedia(db);
  await seedInspectionTimes(db);
  await seedAdminExamples(db);
  await seedProject(db);
  await seedProjectDocuments(db);
  await seedContractors(db);
} catch (e) {
  await db.query("ROLLBACK").catch(() => undefined);
  console.error(`Seed failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  await db.end();
}

