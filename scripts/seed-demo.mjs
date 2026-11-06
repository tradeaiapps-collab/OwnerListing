// Demo data for the LOCAL TEST KIT (docs/LOCAL_TEST.md). Idempotent: does nothing if the demo accounts already exist.
// Refuses to run unless NODE_ENV is not "production" AND DATABASE_URL points at localhost / 127.0.0.1. Usage: npm run seed:demo
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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

/** Labelled floor plan and a short walkthrough video (scripts/demo-media), so the gallery shows both kinds. */
const MEDIA_DIR = new URL("./demo-media/", import.meta.url);
const floorplanImage = () => readFileSync(new URL("floorplan.png", MEDIA_DIR));

const CAPTIONS = ["Street view", "Living room", "Kitchen and dining", "Main bedroom", "Backyard"];

async function seedPhotos(client) {
  const dir = localDevStorageDir(process.env);
  if (!dir) { console.log("Demo photos skipped: LOCAL_STORAGE_DIR is not set (run local-setup again to add it)."); return; }
  const rows = (await client.query(
    `SELECT l.id, l.owner_user_id FROM property_listing l JOIN app_user u ON u.id = l.owner_user_id
     WHERE u.email LIKE '%@demo.invalid' AND NOT EXISTS (SELECT 1 FROM listing_photo_layout p WHERE p.listing_id = l.id)
     ORDER BY l.created_at, l.id`)).rows;
  let made = 0;
  for (const [i, l] of rows.entries()) {
    const entries = [];
    const pictures = [exterior(i), interior(i, 0), interior(i, 1), interior(i, 2), exterior(i + 1)].map((bytes, k) => ({ bytes, kind: "photo", caption: CAPTIONS[k] }));
    pictures.push({ bytes: floorplanImage(), kind: "floorplan", caption: "Floor plan" });
    for (const pic of pictures) {
      const id = randomUUID(), key = `listings/${l.id}/${randomUUID()}`;
      await putLocalObject(dir, key, pic.bytes);
      await client.query(
        `INSERT INTO listing_photo (id, listing_id, kind, uploaded_by, content_type, width, height, size_bytes, sha256, storage_key)
         VALUES ($1, $2, $3, $4, 'image/png', $5, $6, $7, $8, $9)`,
        [id, l.id, pic.kind, l.owner_user_id, W, H, pic.bytes.length, createHash("sha256").update(pic.bytes).digest("hex"), key]);
      entries.push({ photoId: id, caption: pic.caption, alt: "", hidden: false });
      made++;
    }
    await client.query(`INSERT INTO listing_photo_layout (listing_id, version, entries, changed_by) VALUES ($1, 1, $2::jsonb, $3)`, [l.id, JSON.stringify(entries), l.owner_user_id]);
  }
  console.log(rows.length ? `Demo photos added: ${made} images on ${rows.length} listings.` : "Demo photos already present.");
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
// Marcus Bell (marcus.owner) owns six fully populated sale listings: 3 NSW, 2 VIC, 1 QLD. Each has an owner-written description, map pin, a property
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
    rates: { council: 623, water: 214, strata: 0 }, docs: "qld", times: [[6, 600, 660], [3, 1050, 1110]] }
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
    owner = (await client.query(`INSERT INTO app_user (email, display_name, user_type, status) VALUES ($1, 'Marcus Bell (owner, 6 example listings)', 'owner', 'active') RETURNING id`, [email])).rows[0].id;
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
  if ((await db.query(`SELECT 1 FROM app_user WHERE email = $1`, [email])).rows.length) return;
  const id = (await db.query(
    `INSERT INTO app_user (email, display_name, user_type, status, roles, active_role) VALUES ($1, 'Noah Patel (investor)', 'buyer', 'active', ARRAY['buyer','investor'], 'investor') RETURNING id`, [email])).rows[0].id;
  await db.query(`INSERT INTO terms_acceptance (user_id, version) VALUES ($1, '2026-10-24')`, [id]);
  await db.query(`INSERT INTO buyer_verification (user_id, email_verified_at, phone_verified_at, phone_e164, id_verified_at, id_method)
                  VALUES ($1, now(), now(), '+61400000002', now(), 'manual_review')`, [id]);
  console.log("Demo investor created: Noah Patel (fully verified).");
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
    await seedPhotos(db);
    await seedLocations(db);
    await seedFiles(db);
    await seedLeads(db);
    await seedMedia(db);
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
  await seedPhotos(db);
  await seedLocations(db);
  await seedFiles(db);
  await seedLeads(db);
  await seedMedia(db);
} catch (e) {
  await db.query("ROLLBACK").catch(() => undefined);
  console.error(`Seed failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  await db.end();
}

