// Demo data for the LOCAL TEST KIT (docs/LOCAL_TEST.md). Idempotent: does nothing if the demo accounts already exist, except
// filling in later additions (real photos, descriptions, the demo investor project) on a database seeded by an older version.
// Refuses to run unless NODE_ENV is not "production" AND DATABASE_URL points at localhost / 127.0.0.1. Usage: npm run seed:demo
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import pg from "pg";
import { localDevStorageDir, putLocalObject } from "../src/adapters/local-disk-core.mjs";

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
      entries = await storePhotos(client, dir, "listing_photo", "listing_id", l.id, l.owner_user_id, [...pictures, pngPic(floorplan(), "floorplan", "Floor plan")]);
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

const D = "@demo.invalid";
const url = process.env.DATABASE_URL;
if (process.env.NODE_ENV === "production") { console.error("Refusing to seed: NODE_ENV is production."); process.exit(2); }
if (!url) { console.error("DATABASE_URL is required."); process.exit(2); }
// Check the host pg will REALLY use, not just the URL authority: "?host=prod.example.com" (or PGHOST when the URL has none) overrides it.
let host = "";
try { host = String(new pg.Client({ connectionString: url }).connectionParameters.host ?? "").toLowerCase(); } catch { /* handled below */ }
if (host !== "localhost" && host !== "127.0.0.1") { console.error(`Refusing to seed: database host "${host}" is not localhost or 127.0.0.1.`); process.exit(2); }

const db = new pg.Client({ connectionString: url });
await db.connect();
try {
  const exists = await db.query(`SELECT 1 FROM app_user WHERE email = $1`, [`sarah.owner${D}`]);
  if (exists.rows.length) {
    console.log("Demo data already present. (Use local-reset to start again.)");
    await seedDescriptions(db);
    await seedPhotos(db);
    await seedLocations(db);
    await seedProject(db);
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
  await seedDescriptions(db);
  await seedPhotos(db);
  await seedLocations(db);
  await seedProject(db);
} catch (e) {
  await db.query("ROLLBACK").catch(() => undefined);
  console.error(`Seed failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  await db.end();
}

