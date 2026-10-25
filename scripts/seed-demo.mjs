// Demo data for the LOCAL TEST KIT (docs/LOCAL_TEST.md). Idempotent: does nothing if the demo accounts already exist.
// Refuses to run unless NODE_ENV is not "production" AND DATABASE_URL points at localhost / 127.0.0.1. Usage: npm run seed:demo
import { createHash, randomBytes, randomUUID } from "node:crypto";
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
    pictures.push({ bytes: floorplan(), kind: "floorplan", caption: "Floor plan" });
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

const url = process.env.DATABASE_URL;
if (process.env.NODE_ENV === "production") { console.error("Refusing to seed: NODE_ENV is production."); process.exit(2); }
if (!url) { console.error("DATABASE_URL is required."); process.exit(2); }
// Check the host pg will REALLY use, not just the URL authority: "?host=prod.example.com" (or PGHOST when the URL has none) overrides it.
let host = "";
try { host = String(new pg.Client({ connectionString: url }).connectionParameters.host ?? "").toLowerCase(); } catch { /* handled below */ }
if (host !== "localhost" && host !== "127.0.0.1") { console.error(`Refusing to seed: database host "${host}" is not localhost or 127.0.0.1.`); process.exit(2); }

const D = "@demo.invalid";
const db = new pg.Client({ connectionString: url });
await db.connect();
try {
  const exists = await db.query(`SELECT 1 FROM app_user WHERE email = $1`, [`sarah.owner${D}`]);
  if (exists.rows.length) {
    console.log("Demo data already present. (Use local-reset to start again.)");
    await seedPhotos(db);
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
  await seedPhotos(db);
} catch (e) {
  await db.query("ROLLBACK").catch(() => undefined);
  console.error(`Seed failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  await db.end();
}

