// End-to-end smoke test against a RUNNING app and its PostgreSQL. Not run by `npm test`. See docs/DEPLOYMENT.md section 7.
// Needs: DATABASE_URL (migrated), APP_URL (where the app listens), SESSION_SECRET (same as the server's).
// Seeds users straight into the database and signs session cookies the same way src/server/auth/session.ts and staff-session.ts do.
// Use a scratch database only: it inserts rows (users, a listing, a trust account) and the append-only tables cannot be cleaned.
import { createHmac, randomUUID } from "node:crypto";
import pg from "pg";

const need = k => { const v = process.env[k]; if (!v) { console.error(`${k} is required.`); process.exit(2); } return v; };
const DATABASE_URL = need("DATABASE_URL");
const APP_URL = need("APP_URL").replace(/\/$/, "");
const SECRET = need("SESSION_SECRET");
const db = new pg.Client({ connectionString: DATABASE_URL });
await db.connect();

const b64 = b => Buffer.from(b).toString("base64url");
const sign = (payload, key) => { const body = b64(JSON.stringify(payload)); return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`; };
const exp = Math.floor(Date.now() / 1000) + 3600;
const userCookie = (uid, ut) => `ol_session=${sign({ uid, ut, exp }, SECRET)}`;
const staffCookie = uid => `ol_staff=${sign({ uid, exp }, `${SECRET}:staff-session:v1`)}`;

const run = randomUUID().slice(0, 8);
const seedUser = async (type, name, extra = {}) => {
  const email = `${name.toLowerCase().replace(/\W+/g, ".")}.${run}@smoke.invalid`;
  const r = await db.query(
    `INSERT INTO app_user (email, display_name, user_type, status) VALUES ($1, $2, $3, 'active') RETURNING id`, [email, name, type]);
  if (extra.staffRole) await db.query(`INSERT INTO staff_invite (email, role) VALUES ($1, $2)`, [email, extra.staffRole]);
  return r.rows[0].id;
};

const steps = [];
let failed = 0;
// expect: status code (number) or array of acceptable codes. 500, 502 and 504 always fail; 501/503 pass only when listed (provider off by design).
async function step(name, who, method, path, body, expect, check) {
  const headers = { Origin: APP_URL };
  if (who) headers.cookie = who;
  if (body !== undefined) headers["content-type"] = "application/json";
  let status = 0, json = null, text = "";
  try {
    const res = await fetch(APP_URL + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    status = res.status;
    text = await res.text();
    try { json = JSON.parse(text); } catch { /* not json */ }
  } catch (e) { text = String(e); }
  const ok = ![0, 500, 502, 504].includes(status) && (Array.isArray(expect) ? expect : [expect]).includes(status) && (!check || check(json, text));
  if (!ok) failed++;
  steps.push({ step: name, request: `${method} ${path.split("?")[0]}`, status, result: ok ? "ok" : "FAIL" });
  if (!ok) console.error(`FAIL ${name}: ${status} ${text.slice(0, 300)}`);
  return json;
}

const owner = await seedUser("owner", "Smoke Owner");
const buyer = await seedUser("buyer", "Smoke Buyer");
const other = await seedUser("buyer", "Smoke Other Buyer");
const staff = await seedUser("admin", "Smoke Staff", { staffRole: "super_admin" });
const O = userCookie(owner, "owner"), B = userCookie(buyer, "buyer"), X = userCookie(other, "buyer"), S = staffCookie(staff);

// 1. Public pages and anonymous guards
await step("home page loads", null, "GET", "/", undefined, 200);
await step("plans API", null, "GET", "/api/plans", undefined, 200);
await step("anonymous create listing refused", null, "POST", "/api/listings", {}, 401);
{ // CSRF check needs a hostile Origin, which step() does not send
  const res = await fetch(`${APP_URL}/api/listings`, { method: "POST", headers: { Origin: "http://evil.example", cookie: O, "content-type": "application/json" }, body: "{}" });
  const ok = res.status === 403; if (!ok) failed++;
  steps.push({ step: "cross-origin POST refused (CSRF)", request: "POST /api/listings", status: res.status, result: ok ? "ok" : "FAIL" });
}
await step("session cookie resolves to owner", O, "GET", "/api/auth/me", undefined, 200);

// 2. Owner: terms, draft with price
await step("terms in force (owner, before accepting)", O, "GET", "/api/terms", undefined, 200);
await step("create draft before terms refused", O, "POST", "/api/listings", { title: "x" }, [400, 403]);
const terms = await step("terms read", O, "GET", "/api/terms", undefined, 200);
await step("owner accepts terms", O, "POST", "/api/terms", { version: terms?.current?.version, agree: true }, 200);
await step("buyer accepts terms", B, "POST", "/api/terms", { version: terms?.current?.version, agree: true }, 200);
await step("other buyer accepts terms", X, "POST", "/api/terms", { version: terms?.current?.version, agree: true }, 200);
const draft = await step("owner creates draft listing with price", O, "POST", "/api/listings", {
  title: `Smoke house ${run}`, address: "1 Smoke St, Testville QLD 4000", jurisdiction: "QLD", transactionType: "sale",
  useClass: "residential", propertyType: "house", suburb: "Testville", postcode: "4000", priceCents: 85000000, bedrooms: 3, bathrooms: 2, parking: 1
}, 201, j => j?.listing?.id);
const lid = draft?.listing?.id;
await step("owner reads own draft", O, "GET", `/api/listings/${lid}`, undefined, 200);
await step("owner lists own listings", O, "GET", "/api/listings/mine", undefined, 200);
await step("draft not in public browse", null, "GET", `/api/listings?suburb=Testville`, undefined, 200, j => !j.listings.some(l => l.id === lid));

// 3. Publish gate. Blocked by design (see docs/DEPLOYMENT.md): compliance disclosure config empty, fee unpaid, trust account lookup not wired.
const dry = await step("publish dry run (gate reports reasons)", O, "POST", `/api/listings/${lid}/publish?dryRun=1`, undefined, 200, j => j?.decision?.allowed === false);
console.log("publish gate reasons:", JSON.stringify(dry?.decision?.reasons));
await step("publish attempt stays blocked (fails closed)", O, "POST", `/api/listings/${lid}/publish`, undefined, 200, j => j?.decision?.allowed === false);
await step("non-owner cannot publish", X, "POST", `/api/listings/${lid}/publish`, undefined, [403, 404]);

// 4. Seed what staff approval + payment would produce, then publish by SQL (the only blocked step)
const firm = (await db.query(`INSERT INTO law_firm (name, jurisdiction, tier) VALUES ($1, 'QLD', 'registered') RETURNING id`, [`Smoke Law ${run}`])).rows[0].id;
const ta = (await db.query(
  `INSERT INTO trust_account (firm_id, account_name, bsb, account_number_encrypted, details_fingerprint, last_human_approved_fingerprint, approved_by, approved_at)
   VALUES ($1, 'Smoke Law Trust', '064000', '\\x00', $2, $2, $3, now()) RETURNING id`, [firm, `fp-${run}`, staff])).rows[0].id;
await db.query(`INSERT INTO trust_account_check (listing_id, trust_account_id, decision, evidence, reasons) VALUES ($1, $2, 'approved', '{}', '["Seeded by smoke test."]')`, [lid, ta]);
await db.query(`UPDATE property_listing SET listing_fee_paid = true, status = 'published' WHERE id = $1`, [lid]);
steps.push({ step: "SQL seed: approved trust account, fee paid, status published", request: "(database)", status: "-", result: "seeded" });

// 5. Buyer browse and search
await step("public listing detail", null, "GET", `/api/listings/${lid}`, undefined, 200);
await step("browse published", null, "GET", "/api/listings", undefined, 200, j => j.listings.some(l => l.id === lid));
await step("search by suburb, price, beds", null, "GET", "/api/listings?transactionType=sale&suburb=Testville&minPriceCents=80000000&maxPriceCents=90000000&minBedrooms=3&sort=price_asc", undefined, 200, j => j.listings.some(l => l.id === lid));
await step("search excludes out-of-range price", null, "GET", "/api/listings?transactionType=sale&suburb=Testville&maxPriceCents=1000", undefined, 200, j => !j.listings.some(l => l.id === lid));
await step("buyer saves listing", B, "POST", "/api/buyer/saved-listings", { listingId: lid }, [200, 201]);
await step("buyer saved listings", B, "GET", "/api/buyer/saved-listings", undefined, 200);
await step("buyer saves a search", B, "POST", "/api/buyer/saved-searches", { transactionType: "sale", useClass: "residential", jurisdictions: ["QLD"], suburbs: ["Testville"], propertyTypes: ["house"] }, [200, 201]);
await step("buyer alert preferences", B, "GET", "/api/buyer/alert-preferences", undefined, 200);

// 6. Verification: unverified buyer cannot enquire; then seed verified
await step("buyer verification status (unverified)", B, "GET", "/api/buyer/verification", undefined, 200);
await step("unverified buyer enquiry refused", B, "POST", `/api/listings/${lid}/enquiries`, { body: "Hello, is it available?" }, [400, 403]);
await db.query(`INSERT INTO buyer_verification (user_id, email_verified_at, phone_verified_at, id_verified_at, id_method) VALUES ($1, now(), now(), now(), 'manual_review')`, [buyer]);
steps.push({ step: "SQL seed: buyer verification (email, phone, id)", request: "(database)", status: "-", result: "seeded" });
await step("buyer verification status (verified)", B, "GET", "/api/buyer/verification", undefined, 200);

// 7. Enquiry and messages
const enq = await step("buyer starts enquiry", B, "POST", `/api/listings/${lid}/enquiries`, { body: "Hello, is it still available?" }, 201);
const eid = enq?.enquiry?.id ?? enq?.enquiryId ?? enq?.id ?? enq?.thread?.id;
if (!eid) { console.error("No enquiry id in response:", JSON.stringify(enq)); }
await step("owner inbox", O, "GET", "/api/enquiries", undefined, 200, j => j.items.length >= 1);
await step("owner reads thread", O, "GET", `/api/enquiries/${eid}/messages`, undefined, 200);
await step("owner replies", O, "POST", `/api/enquiries/${eid}/messages`, { body: "Yes, inspections Saturday." }, 201);
await step("buyer replies", B, "POST", `/api/enquiries/${eid}/messages`, { body: "Great, thanks." }, 201);
await step("other buyer cannot read thread", X, "GET", `/api/enquiries/${eid}/messages`, undefined, [403, 404]);
await step("messages cannot be deleted (no DELETE)", O, "DELETE", `/api/enquiries/${eid}/messages`, undefined, [405]);

// 8. Offer link: request, issue
await step("offer link state (none yet)", B, "GET", `/api/enquiries/${eid}/offer-link`, undefined, 200);
await step("owner cannot request on buyer's behalf", O, "POST", `/api/enquiries/${eid}/offer-link`, { action: "request" }, [400, 403, 404]);
await step("buyer requests offer link", B, "POST", `/api/enquiries/${eid}/offer-link`, { action: "request" }, 201);
await step("buyer cannot issue own link", B, "POST", `/api/enquiries/${eid}/offer-link`, { action: "issue" }, [400, 403, 404]);
const issued = await step("owner issues offer link", O, "POST", `/api/enquiries/${eid}/offer-link`, { action: "issue" }, 201);
const state = await step("buyer sees link token", B, "GET", `/api/enquiries/${eid}/offer-link`, undefined, 200);
const token = state?.token ?? state?.link?.token ?? issued?.token;
if (!token) console.error("No offer token visible to buyer. state:", JSON.stringify(state), "issued:", JSON.stringify(issued));

// 9. Offer submit
const offerBody = { token, priceCents: 84000000, conditions: ["Subject to finance"], settlementDays: 45, depositCents: 8400000, confirmedFinal: true };
await step("other buyer cannot use the link", X, "POST", `/api/listings/${lid}/offers`, offerBody, [400, 403]);
await step("offer without sign-in refused", null, "POST", `/api/listings/${lid}/offers`, offerBody, 401);
const offer = await step("buyer submits formal offer", B, "POST", `/api/listings/${lid}/offers`, offerBody, 201);
await step("link is single use", B, "POST", `/api/listings/${lid}/offers`, offerBody, [400, 409]);

// 10. Owner views
const offers = await step("owner views offers", O, "GET", `/api/listings/${lid}/offers`, undefined, 200, j => j.offers.length === 1);
const offerId = offers?.offers?.[0]?.id ?? offer?.offer?.id;
await step("buyer cannot view offers", B, "GET", `/api/listings/${lid}/offers`, undefined, [403, 404]);
await step("offer analysis (deterministic)", O, "GET", `/api/listings/${lid}/offer-analysis`, undefined, 200, j => j.rows.length === 1);
await step("offer analysis AI summary (engine off, fails closed)", O, "POST", `/api/listings/${lid}/offer-analysis`, {}, 200, j => j.ai?.state === "unavailable");
await step("contract draft preview", O, "POST", `/api/listings/${lid}/contract-draft`, { offerId }, 200, j => !!j.draft);

// 11. Reports
await step("owner listing report", O, "GET", `/api/listings/${lid}/report`, undefined, 200);
await step("owner all-listings report", O, "GET", "/api/listings/mine/report", undefined, 200);
await step("non-owner listing report refused", X, "GET", `/api/listings/${lid}/report`, undefined, 404);
await step("staff identity", S, "GET", "/api/staff/me", undefined, 200);
await step("owner cookie is not staff", O, "GET", "/api/staff/reports", undefined, [401, 403]);
await step("staff report (JSON)", S, "GET", "/api/staff/reports", undefined, 200, j => !!j.report);
await step("staff report (CSV)", S, "GET", "/api/staff/reports?format=csv", undefined, 200);
await step("staff trust accounts queue", S, "GET", "/api/staff/trust-accounts", undefined, 200);
await step("staff cases", S, "GET", "/api/staff/cases", undefined, 200);
await step("staff audit", S, "GET", "/api/staff/audit", undefined, 200);

// 11b. Pages render (no server error)
for (const p of ["/plans", "/terms", "/listings", "/listings/new", `/listings/${lid}`, "/listings/mine", `/listings/${lid}/offers`, `/listings/${lid}/offer-analysis`, `/listings/${lid}/contract-draft`, "/reports", "/dashboard", "/settings"]) {
  await step(`page ${p.replace(lid, ":id")}`, O, "GET", p, undefined, 200);
}
for (const p of ["/enquiries", `/enquiries/${eid}`, `/listings/${lid}/enquire`, "/buyer/saved-listings", "/buyer/saved-searches", "/buyer/verification"]) {
  await step(`page ${p.replace(lid, ":id").replace(eid, ":eid")}`, B, "GET", p, undefined, 200);
}
for (const p of ["/staff", "/staff/reports", "/staff/trust-accounts", "/staff/cases", "/staff/audit", "/staff/pricing", "/staff/id-review"]) {
  await step(`page ${p}`, S, "GET", p, undefined, 200);
}

// 12. Provider-off routes fail closed by design
await step("checkout not available (PayWay off)", O, "POST", `/api/listings/${lid}/checkout`, {}, [400, 403, 404, 409, 501, 503]);
await step("payway webhook rejects unsigned post", null, "POST", "/api/webhooks/payway", { x: 1 }, [400, 401, 403, 503]); // 503 = disabled while PAYWAY_WEBHOOK_SECRET is unset

await db.end();
console.table(steps);
console.log(failed === 0 ? `All ${steps.length} steps passed.` : `${failed} step(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
