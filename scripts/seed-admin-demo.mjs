// Example data for the staff (admin) pages of the LOCAL TEST KIT, so they open populated instead of empty.
// Called from scripts/seed-demo.mjs (which already guards: not production, DATABASE_URL on localhost). Also runnable alone:
//   DATABASE_URL=postgres://...@localhost/... npm run seed:admin
// Every section is idempotent (its own marker row) and runs in its own transaction. Needs the base demo accounts.
// Illustrative numbers only: nothing here is real, and every email ends in @demo.invalid.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";

const D = "@demo.invalid";
const sha = s => createHash("sha256").update(s).digest("hex");
/** SQL for "N days (and H hours) ago". Only ever called with numbers from this file. */
const ago = (days, hours = 0) => `now() - interval '${Number(days)} days' - interval '${Number(hours)} hours'`;
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString();

async function inTx(db, name, fn) {
  await db.query("BEGIN");
  try {
    const msg = await fn();
    await db.query("COMMIT");
    if (msg) console.log(msg);
  } catch (e) {
    await db.query("ROLLBACK").catch(() => undefined);
    console.error(`Admin demo section "${name}" failed: ${e.message}`);
    throw e;
  }
}

async function people(db) {
  const rows = (await db.query(`SELECT email, id FROM app_user WHERE email LIKE '%@demo.invalid'`)).rows;
  const by = Object.fromEntries(rows.map(r => [r.email.replace(D, ""), r.id]));
  const need = ["staff.super_admin", "staff.compliance", "staff.support", "sarah.owner", "daniel.owner", "marcus.owner", "james.buyer", "emma.buyer", "liam.buyer", "noah.investor"];
  const missing = need.filter(k => !by[k]);
  return missing.length ? { missing } : { by };
}

// ---- 1. Negotiation coaching: how often each Elena suggestion is used, and how coached deals end versus the rest -----------------
// 17 ended deals. Coached (a suggestion was used) = 12 deals, 8 settled. Not coached (suggestions shown, all dismissed) = 5 deals, 2 settled.
// [suburb, state, postcode, type, listing $K, offer $K, owner, buyer, outcome, days to settle, days since accepted, [[suggestion, side, used]]]
const COACH_DEALS = [
  ["Kenmore", "QLD", "4069", "house", 980, 965, "sarah.owner", "james.buyer", "settled", 41, 150, [["inspection_window_short", "buyer", true], ["deposit_low", "seller", true]]],
  ["Toowong", "QLD", "4066", "unit", 640, 628, "daniel.owner", "emma.buyer", "settled", 38, 140, [["finance_unverified", "seller", true], ["settlement_long", "buyer", false]]],
  ["Chermside", "QLD", "4032", "house", 870, 880, "sarah.owner", "liam.buyer", "settled", 44, 128, [["price_gap_compromise", "buyer", true]]],
  ["Newtown", "NSW", "2042", "unit", 1180, 1150, "daniel.owner", "james.buyer", "settled", 47, 117, [["settlement_flex_trade", "seller", true], ["subject_to_sale", "seller", false]]],
  ["Marrickville", "NSW", "2204", "house", 1520, 1495, "sarah.owner", "emma.buyer", "settled", 36, 109, [["inspection_waived", "buyer", true]]],
  ["Brunswick", "VIC", "3056", "house", 1010, 990, "daniel.owner", "liam.buyer", "settled", 43, 98, [["finance_timeline_tight", "buyer", true], ["settlement_too_short", "seller", true]]],
  ["Northcote", "VIC", "3070", "house", 1390, 1410, "sarah.owner", "james.buyer", "settled", 40, 90, [["price_gap_compromise", "seller", true]]],
  ["Fitzroy", "VIC", "3065", "unit", 760, 745, "daniel.owner", "emma.buyer", "settled", 49, 81, [["deposit_low", "seller", true], ["inspection_window_short", "buyer", false]]],
  ["Paddington", "QLD", "4064", "house", 1300, 1250, "sarah.owner", "liam.buyer", "fell_through", null, 74, [["finance_unverified", "seller", true]]],
  ["Bondi", "NSW", "2026", "unit", 1450, 1380, "daniel.owner", "james.buyer", "fell_through", null, 66, [["subject_to_sale", "seller", true], ["settlement_long", "seller", false]]],
  ["Richmond", "VIC", "3121", "unit", 690, 660, "sarah.owner", "emma.buyer", "fell_through", null, 58, [["inspection_waived", "buyer", true]]],
  ["Bulimba", "QLD", "4171", "house", 1220, 1175, "daniel.owner", "liam.buyer", "fell_through", null, 49, [["finance_timeline_tight", "buyer", true]]],
  ["Coogee", "NSW", "2034", "unit", 1090, 1105, "sarah.owner", "james.buyer", "settled", 61, 133, [["inspection_waived", "buyer", false], ["deposit_low", "seller", false]]],
  ["Carlton", "VIC", "3053", "house", 1580, 1560, "daniel.owner", "emma.buyer", "settled", 68, 104, [["settlement_long", "seller", false]]],
  ["Ascot", "QLD", "4007", "house", 1810, 1700, "sarah.owner", "liam.buyer", "fell_through", null, 86, [["finance_unverified", "seller", false], ["subject_to_sale", "seller", false]]],
  ["Manly", "NSW", "2095", "unit", 1320, 1250, "daniel.owner", "james.buyer", "fell_through", null, 71, [["price_gap_compromise", "buyer", false]]],
  ["Hawthorn", "VIC", "3122", "house", 1660, 1590, "sarah.owner", "emma.buyer", "fell_through", null, 52, [["inspection_window_short", "buyer", false], ["finance_timeline_tight", "buyer", false]]]
];
const STAGES = ["offer_accepted", "deposit_received", "cooling_off_expires", "inspection_completed", "finance_approval", "lawyer_exchange", "settlement_scheduled", "settlement_completed"];

// Disputes on some of those deals, one per status so every lane shows: [deal index, type, title, description, claim $, who raised, status, rounds, agreed seller share]
const DISPUTES = [
  [8, "financing", "Lender valuation came in under the contract price", "The buyer's valuation is $40,000 below the price. The buyer asks the seller to share the gap.", 40000, "buyer", "mediating", 1, null],
  [9, "inspection", "Building report found roof damage", "Report lists a damaged roof section, quoted at $12,500. Buyer wants a price reduction.", 12500, "buyer", "escalated", 3, null],
  [10, "repair", "Agreed repairs not finished before settlement", "Two items on the repair list are incomplete with five days to settlement.", 3800, "buyer", "awaiting_position", 0, null],
  [1, "repair", "Fence repair before final inspection", "Seller repaired the fence. Both sides accepted a 60/40 split of the $2,400 cost.", 2400, "seller", "agreed", 1, 60],
  [0, "cooling_off", "Buyer asked to extend cooling-off", "Buyer asked for two extra days; the seller agreed after Elena's suggestion.", null, "buyer", "resolved", 1, 50]
];

// Elena suggestion log for the Elena insights and training pages: [feature, type, [accepted, modified, rejected, ignored] counts]
const ELENA_MIX = [
  ["negotiation_coach", "inspection_window_short", [9, 2, 3, 2]], ["negotiation_coach", "deposit_low", [8, 3, 2, 1]], ["negotiation_coach", "settlement_long", [4, 2, 6, 4]],
  ["negotiation_coach", "price_gap_compromise", [11, 4, 2, 1]], ["negotiation_coach", "finance_unverified", [7, 1, 3, 2]],
  ["enquiry_reply", "availability", [14, 6, 2, 1]], ["enquiry_reply", "price_question", [9, 5, 4, 3]], ["enquiry_reply", "inspection_request", [16, 3, 1, 1]],
  ["offer_response", "counter_offer", [6, 4, 3, 2]], ["offer_response", "decline_politely", [7, 2, 1, 1]],
  ["mediation", "split_repair_cost", [5, 2, 2, 1]], ["message_moderation", "tone_rewrite", [8, 3, 3, 2]], ["listing_optimization", "add_photos", [10, 2, 4, 5]]
];
const REGIONS = ["QLD", "NSW", "VIC", "QLD", "WA", "NSW", "SA", "VIC"];

async function seedCoaching(db, P) {
  if ((await db.query(`SELECT 1 FROM property_listing WHERE title LIKE '%(coaching demo)'`)).rows.length) return;
  const boss = P.by["staff.super_admin"];
  const ta = (await db.query(`SELECT id FROM trust_account WHERE account_name LIKE 'Harbour Legal Trust%' LIMIT 1`)).rows[0]?.id;
  await inTx(db, "negotiation coaching", async () => {
    const q = async (text, params) => (await db.query(text, params)).rows;
    const settlements = [];
    for (const [i, [suburb, st, pc, type, listK, offerK, owner, buyer, outcome, days, since, sugg]] of COACH_DEALS.entries()) {
      const lid = (await q(
        `INSERT INTO property_listing (owner_user_id, jurisdiction, transaction_type, use_class, property_type, title, address_text, suburb, postcode, price_cents, bedrooms, bathrooms, parking, status, listing_fee_paid, terms_accepted, created_at)
         VALUES ($1, $2, 'sale', 'residential', $3, $4, $5, $6, $7, $8, 3, 2, 1, 'published', true, true, ${ago(since + 30)}) RETURNING id`,
        [P.by[owner], st, type, `${suburb} ${type === "house" ? "family home" : "apartment"} (coaching demo)`, `${10 + i} Example St, ${suburb} ${st} ${pc}`, suburb, pc, listK * 100000]))[0].id;
      if (ta) await q(`INSERT INTO trust_account_check (listing_id, trust_account_id, decision, evidence, reasons) VALUES ($1, $2, 'approved', '{}', '["Demo data"]')`, [lid, ta]);
      const hash = randomBytes(32).toString("hex");
      await q(`INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at, used_at) VALUES ($1, $2, $3, now() + interval '7 days', ${ago(since)})`, [hash, lid, P.by[buyer]]);
      const status = outcome === "settled" ? "accepted" : "fallen_through";
      const oid = (await q(
        `INSERT INTO formal_offer (listing_id, buyer_user_id, price_cents, conditions, settlement_days, deposit_cents, confirmed_final, link_token_hash, status, submitted_at)
         VALUES ($1, $2, $3, '["Subject to finance","Subject to building and pest inspection"]'::jsonb, 42, $4, true, $5, $6, ${ago(since)}) RETURNING id`,
        [lid, P.by[buyer], offerK * 100000, offerK * 1000, hash, status]))[0].id;
      await q(`INSERT INTO offer_event (offer_id, event_type, actor_kind, actor_user_id, price_cents, settlement_days, occurred_at) VALUES ($1, 'submitted', 'buyer', $2, $3, 42, ${ago(since)})`, [oid, P.by[buyer], offerK * 100000]);
      await q(`INSERT INTO offer_event (offer_id, event_type, actor_kind, actor_user_id, occurred_at) VALUES ($1, 'accepted', 'owner', $2, ${ago(since)} + interval '6 hours')`, [oid, P.by[owner]]);
      const sid = randomUUID();
      const reached = outcome === "settled" ? STAGES.length - 1 : 4 + (i % 2);
      await q(
        `INSERT INTO settlement_timeline (id, offer_id, listing_id, buyer_id, seller_id, state, current_stage, stage_entered_at, completed_at, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, ${ago(since)}, ${outcome === "settled" ? `${ago(since)} + interval '${days} days'` : "NULL"}, $5, ${ago(since)})`,
        [sid, oid, lid, P.by[buyer], P.by[owner], st, STAGES[reached]]);
      settlements.push({ sid, owner, buyer });
      for (const [type2, side, used] of sugg) {
        await q(
          `INSERT INTO negotiation_coaching_offers (offer_id, settlement_id, suggestion_type, side, accepted, decided_by, decided_at, shown_at, outcome, outcome_at, days_to_settle)
           VALUES ($1, $2, $3, $4, $5, $6, ${ago(since, -1)}, ${ago(since, 2)}, $7, ${ago(since)} + interval '${days ?? 20} days', $8)`,
          [oid, sid, type2, side, used, side === "buyer" ? P.by[buyer] : P.by[owner], outcome, days]);
      }
      if (outcome === "settled") {
        await q(`INSERT INTO settlement_outcomes (settlement_id, outcome, time_to_settlement_days, final_price_cents, negotiation_count, source) VALUES ($1, 'settled', $2, $3, $4, 'auto') ON CONFLICT DO NOTHING`, [sid, days, offerK * 100000, 1 + (i % 3)]);
      } else {
        await q(`INSERT INTO settlement_outcomes (settlement_id, outcome, negotiation_count, source) VALUES ($1, 'fell_through', $2, 'auto') ON CONFLICT DO NOTHING`, [sid, 2 + (i % 2)]);
      }
    }

    for (const [idx, type, title, description, claim, side, status, rounds, agreedPct] of DISPUTES) {
      const s = settlements[idx];
      const done = ["agreed", "resolved", "withdrawn"].includes(status);
      const noPositions = status === "awaiting_position";
      const id = (await q(
        `INSERT INTO disputes (settlement_id, type, title, description, initiated_by, initiated_by_side, claim_cents, buyer_position, buyer_share_pct, seller_position, seller_share_pct, status, current_round,
           deadline_at, escalation_reason, escalated_at, agreed_seller_share_pct, outcome, resolved_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now() + interval '5 days', $14, $15, $16, $17, $18, now() - interval '9 days') RETURNING id`,
        [s.sid, type, title, description, side === "buyer" ? P.by[s.buyer] : P.by[s.owner], side, claim ? claim * 100 : null,
          noPositions ? null : "The seller should cover most of this.", noPositions ? null : 30,
          noPositions ? null : "The sale price already reflects the condition.", noPositions ? null : 70,
          status, rounds, status === "escalated" ? "max_rounds" : null, status === "escalated" ? daysAgo(2) : null, agreedPct,
          done ? "Agreed through Elena's mediation; recorded for the similar-disputes history." : null, done ? daysAgo(3) : null]))[0].id;
      if (rounds >= 1) {
        await q(`INSERT INTO dispute_mediation_rounds (dispute_id, round, elena_suggestion, buyer_response, seller_response, resolved) VALUES ($1, 1, $2::jsonb, $3, $4, $5)`,
          [id, JSON.stringify({ sellerSharePct: 60, note: "A 60/40 split is common for items of this size." }), done ? "accept" : "counter", done ? "accept" : "counter", done]);
      }
      if (status === "escalated") {
        await q(`INSERT INTO dispute_staff_actions (dispute_id, staff_user_id, action, note) VALUES ($1, NULL, 'auto_escalated', 'Three rounds without agreement.'), ($1, $2, 'claimed', 'Support will call both parties.')`, [id, P.by["staff.support"]]);
      }
    }

    // Elena suggestion log with feedback (Elena insights, training and the monthly learning run).
    let n = 0;
    const actions = ["accepted", "modified", "rejected", "ignored"];
    for (const [feature, type, counts] of ELENA_MIX) {
      for (const [k, count] of counts.entries()) {
        for (let j = 0; j < count; j++, n++) {
          const consent = n % 3 !== 0, coach = feature === "negotiation_coach", when = 1 + (n * 7) % 85;
          const eid = (await q(
            `INSERT INTO elena_suggestion (feature, suggestion_type, suggestion_text, user_role, region, consent_for_training, source, created_at, experiment_key, arm)
             VALUES ($1, $2, $3, $4, $5, $6, 'direct', ${ago(when, n % 20)}, $7, $8) RETURNING id`,
            [feature, type, consent ? `Example ${type.replace(/_/g, " ")} suggestion.` : null, coach ? (n % 2 ? "buyer" : "owner") : "owner", REGIONS[n % REGIONS.length], consent,
              coach ? "coach_tone_test" : null, coach ? (n % 2 ? "friendly" : "direct") : null]))[0].id;
          await q(`INSERT INTO elena_feedback (suggestion_id, action, helpful, rating, response_seconds, source, created_at) VALUES ($1, $2, $3, $4, $5, 'auto', ${ago(when)})`,
            [eid, actions[k], ["yes", "partial", "no", null][k], k === 0 ? 4 + (n % 2) : k === 2 ? 1 + (n % 2) : null, 20 + (n * 13) % 400]);
        }
      }
    }
    await q(`INSERT INTO elena_experiment (key, feature, arms, created_by) VALUES ('coach_tone_test', 'negotiation_coach', ARRAY['direct','friendly'], $1) ON CONFLICT DO NOTHING`, [boss]);
    await q(`INSERT INTO elena_learned_config (version, status, config, evidence, created_at) VALUES (1, 'retired', $1::jsonb, $2::jsonb, ${ago(60)}) ON CONFLICT DO NOTHING`,
      [JSON.stringify({ engine: "elena-learning-v1", typeWeights: { "negotiation_coach/settlement_long": 0.85 }, regionWeights: {}, trainedOn: 41 }), JSON.stringify({ sample: 41, notes: ["First monthly run."] })]);
    await q(`INSERT INTO elena_learned_config (version, status, config, evidence) VALUES (2, 'proposed', $1::jsonb, $2::jsonb) ON CONFLICT DO NOTHING`,
      [JSON.stringify({ engine: "elena-learning-v1", typeWeights: { "negotiation_coach/price_gap_compromise": 1.12, "negotiation_coach/settlement_long": 0.82, "enquiry_reply/inspection_request": 1.08 }, regionWeights: { NSW: { "negotiation_coach/deposit_low": 1.1 } }, trainedOn: 119 }),
        JSON.stringify({ sample: 119, notes: ["NSW differs from the national result for negotiation_coach/deposit_low (88% vs 71%)."] })]);
    return `Admin demo: negotiation coaching (17 ended deals: 12 coached with 8 settled, 5 not coached with 2 settled), 5 disputes, ${n} Elena suggestions with feedback, 2 learned-setting versions.`;
  });
}

// ---- 2. Moderation: listings waiting for staff review, wording flags, flagged seller messages ------------------------------------
const ADVICE = {
  profanity: { id: "wording-profanity", area: "wording", message: "The description contains language that may be offensive. Check it reads professionally." },
  abuse: { id: "wording-abuse", area: "wording", message: "A photo caption reads as abusive towards neighbours. Ask the owner to reword it." },
  explicit: { id: "photos-explicit", area: "photos", message: "One photo may not be suitable for a property listing. Check it before it stays live." },
  photosFew: { id: "photos-few", area: "photos", message: "Only 3 photos. Listings with 5 or more get far more enquiries." },
  short: { id: "description-short", area: "description", message: "The description is short (74 characters). Buyers expect more about the home and the area." },
  alt: { id: "photos-alt", area: "photos", message: "4 photos have no description for screen readers." },
  parking: { id: "parking", area: "details", message: "Parking spaces are not filled in. Enter 0 if there are none." },
  dup: { id: "photos-duplicate", area: "photos", message: "Two photos look identical. Duplicate photos can look like padding." }
};

async function seedModeration(db, P) {
  if ((await db.query(`SELECT 1 FROM listing_moderation_queue LIMIT 1`)).rows.length || (await db.query(`SELECT 1 FROM wording_flag LIMIT 1`)).rows.length) return;
  const comp = P.by["staff.compliance"], owner = P.by["marcus.owner"];
  await inTx(db, "moderation", async () => {
    const q = async (text, params) => (await db.query(text, params)).rows;
    const lst = await q(`SELECT id FROM property_listing WHERE owner_user_id = $1 ORDER BY created_at, id LIMIT 12`, [owner]);
    if (lst.length < 12) throw new Error("expected the example listings of marcus.owner");
    // status, hours since queued, advice keys: open items first, reviewed ones show the history.
    const queue = [
      ["open", 3, ["profanity", "short"]], ["open", 7, ["abuse"]], ["open", 20, ["explicit", "photosFew"]], ["open", 30, ["dup", "alt"]],
      ["open", 52, ["photosFew", "parking"]], ["open", 70, ["short", "alt", "parking"]],
      ["reviewed", 100, ["profanity"]], ["reviewed", 130, ["dup"]], ["reviewed", 190, ["abuse", "alt"]]
    ];
    for (const [i, [status, hours, keys]] of queue.entries()) {
      const adv = keys.map(k => ADVICE[k]), reviewed = status === "reviewed";
      await q(
        `INSERT INTO listing_moderation_queue (listing_id, published_by, advice_count, advice, status, queued_at, reviewed_at, reviewed_by)
         VALUES ($1, $2, $3, $4::jsonb, $5, now() - $6::int * interval '1 hour', ${reviewed ? "now() - ($6::int - 5) * interval '1 hour'" : "NULL"}, $7)`,
        [lst[i].id, owner, adv.length, JSON.stringify(adv), status, hours, reviewed ? comp : null]);
    }
    // Wording flags (anti-discrimination filter): open, cleared (lawful exception) and upheld.
    const flags = [
      [9, "description", "perfect for young professionals only", "age", "age-young", "open"],
      [10, "title", "no kids", "familial_status", "family-no-kids", "open"],
      [11, "description", "christian family preferred", "religion", "religion-preferred", "open"],
      [6, "description", "ideal for retirees over 55", "age", "age-over-55", "cleared", "Registered seniors housing estate: lawful age restriction, evidence checked."],
      [7, "description", "no pensioners or single mums", "income_source", "income-pension", "upheld", "Discriminates on income source and relationship status. Owner must reword."]
    ];
    for (const [idx, field, text, cat, rule, status, reason] of flags) {
      const open = status === "open";
      await q(
        `INSERT INTO wording_flag (listing_id, field, flag_key, match_text, category, rule_id, status, raised_by, first_raised_at, last_raised_at, attempts, reviewed_by, reviewed_at, review_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() - interval '3 days', now() - interval '1 day', $9, $10, $11, $12)`,
        [lst[idx].id, field, `${field}:${text}`, text, cat, rule, status, owner, open ? 2 : 1, open ? null : comp, open ? null : daysAgo(1), reason ?? null]);
    }
    // Seller-side messages flagged by Elena (tone and compliance). Messages are never blocked; staff record one decision.
    const msgs = [
      ["sarah.owner", "james.buyer", "I'm sick of your lowball emails. Stop wasting my time or I'll block you.", "high", "aggressive", ["tone", "harassment"], "open"],
      ["daniel.owner", "emma.buyer", "Between us, the roof leaks but just don't mention it in the inspection.", "high", "neutral", ["disclosure", "misleading"], "open"],
      ["sarah.owner", "liam.buyer", "We prefer buyers without kids, the neighbours are quiet.", "medium", "neutral", ["discrimination"], "open"],
      ["daniel.owner", "james.buyer", "Honestly this is ridiculous, I've answered the same question three times.", "low", "frustrated", ["tone"], "educated"],
      ["sarah.owner", "emma.buyer", "Pay the deposit straight to my personal account to hold the place.", "high", "neutral", ["payment_off_platform"], "revision_requested"],
      ["daniel.owner", "liam.buyer", "The price is firm. For questions about the title search, ask the solicitor.", "low", "neutral", ["tone"], "approved"]
    ];
    const notes = { educated: "Sent the seller the tone guide.", revision_requested: "Asked the seller to remove the request and use the trust account.", approved: "Firm but polite. No action." };
    for (const [i, [seller, buyer, body, severity, tone, cats, status]] of msgs.entries()) {
      const listing = (await q(`SELECT id FROM property_listing WHERE owner_user_id = $1 AND title NOT LIKE '%(coaching demo)' ORDER BY created_at, id LIMIT 1`, [P.by[seller]]))[0]?.id;
      if (!listing) continue;
      const eid = (await q(`INSERT INTO enquiry (listing_id, buyer_user_id) VALUES ($1, $2) ON CONFLICT (listing_id, buyer_user_id) DO UPDATE SET listing_id = EXCLUDED.listing_id RETURNING id`, [listing, P.by[buyer]]))[0].id;
      const mid = (await q(`INSERT INTO enquiry_message (enquiry_id, sender_user_id, body, sent_at) VALUES ($1, $2, $3, now() - $4::int * interval '1 hour') RETURNING id`, [eid, P.by[seller], body, 6 + i * 11]))[0].id;
      const reviewed = status !== "open";
      await q(
        `INSERT INTO message_moderation_flag (enquiry_id, message_id, sender_user_id, severity, tone, categories, flags, rules_version, status, reviewed_by, reviewed_at, review_note, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'demo-1', $8, $9, ${reviewed ? "now() - interval '2 hours'" : "NULL"}, $10, now() - $11::int * interval '1 hour')`,
        [eid, mid, P.by[seller], severity, tone, cats, JSON.stringify(cats.map(c => ({ category: c, note: `Matched the ${c.replace(/_/g, " ")} rule.` }))), status, reviewed ? comp : null, notes[status] ?? null, 5 + i * 11]);
    }
    return "Admin demo: moderation (9 listings in the review queue: 6 open and 3 reviewed, 5 wording flags, 6 flagged seller messages).";
  });
}

// ---- 3. Investor module: projects in every review state, interest, contracts, fees, documents, settings -----------------------
// title, location, state, type, stage, target $, min ticket $, status, version, visible to, review reason, interests
const PROJECTS = [
  ["Riverside Terraces", "Bulimba, Brisbane", "QLD", "residential_development", "approved", 4800000, 50000, "approved", 2, "wholesale_only", "Approved after planning approval and issuer licence were checked.", 3],
  ["Harbour View Apartments", "Pyrmont, Sydney", "NSW", "residential_development", "construction", 12500000, 100000, "approved", 1, "wholesale_only", "Documents complete and issuer verified.", 2],
  ["Gum Tree Estate Subdivision", "Wodonga, Victoria", "VIC", "land_subdivision", "planning", 2200000, 25000, "pending_review", 1, "all_verified", null, 0],
  ["Corner Shops Fit-out", "Subiaco, Perth", "WA", "commercial_development", "concept", 950000, 20000, "pending_review", 1, "wholesale_only", null, 0],
  ["Federation Cottage Renovation", "Hawthorn, Melbourne", "VIC", "renovation", "approved", 780000, 10000, "changes_requested", 1, "all_verified", "The risks section needs the builder's insurance details and a clearer exit plan.", 0],
  ["Quick Flip Units", "Gold Coast", "QLD", "residential_development", "concept", 3000000, 50000, "rejected", 1, "all_verified", "Promises a fixed return, which is not allowed on the platform. Describe the project and its risks only.", 0]
];
const DOCS = [["plan", "Site and floor plans", "investors"], ["approval", "Development approval", "investors"], ["feasibility", "Feasibility study", "team"], ["contract", "Draft subscription agreement", "private"], ["report", "Quarterly progress report", "investors"]];

async function seedInvestments(db, P) {
  if ((await db.query(`SELECT 1 FROM investment_project WHERE title = 'Harbour View Apartments'`)).rows.length) return;
  const boss = P.by["staff.super_admin"], comp = P.by["staff.compliance"];
  await inTx(db, "investor module", async () => {
    const q = async (text, params) => (await db.query(text, params)).rows;
    const mk = async (key, name, roles, phone) => {
      const email = `${key}${D}`;
      const found = (await q(`SELECT id FROM app_user WHERE email = $1`, [email]))[0]?.id;
      if (found) return found;
      const id = (await q(`INSERT INTO app_user (email, display_name, user_type, status, roles, active_role) VALUES ($1, $2, 'buyer', 'active', $3, $4) RETURNING id`, [email, name, roles, roles[roles.length - 1]]))[0].id;
      await q(`INSERT INTO terms_acceptance (user_id, version) VALUES ($1, '2026-10-24')`, [id]);
      await q(`INSERT INTO buyer_verification (user_id, email_verified_at, phone_verified_at, phone_e164, id_verified_at, id_method) VALUES ($1, now(), now(), $2, now(), 'manual_review')`, [id, phone]);
      return id;
    };
    const owners = [await mk("olivia.projects", "Olivia Hart (project owner)", ["buyer", "owner"], "+61400550011"), await mk("ravi.developer", "Ravi Menon (project owner)", ["buyer", "owner"], "+61400550022")];
    const investors = [P.by["noah.investor"], await mk("grace.investor", "Grace Lim (investor)", ["buyer", "investor"], "+61400550033"), await mk("hugo.investor", "Hugo Brandt (investor)", ["buyer", "investor"], "+61400550044")];
    for (const [i, id] of investors.entries()) {
      await q(`INSERT INTO investor_declaration (user_id, category, ack_not_advice, ack_not_offer, ack_no_funds_held, ack_off_platform, disclosure_version, declared_at) VALUES ($1, $2, true, true, true, true, 'local-demo', ${ago(40 - i * 9)})`, [id, ["wholesale", "sophisticated", "wholesale"][i]]);
    }
    // Posting model 1: 1.5% commission when a signed contract is returned. Applies to the projects below.
    await q(`INSERT INTO investment_posting_setting (key, model, commission_type, commission_bps, commission_fixed_cents, upfront_fee_cents, model2_disclosure, updated_by) VALUES ('posting', 'commission_on_contract', 'percent', 150, 0, 0, 'off', $1) ON CONFLICT (key) DO NOTHING`, [boss]);
    await q(`INSERT INTO investment_posting_setting_history (settings, changed_by) VALUES ($1::jsonb, $2)`, [JSON.stringify({ model: "commission_on_contract", commissionType: "percent", commissionBps: 150 }), boss]);

    const hist = (id, from, to, actorType, actor, reason, version, when) =>
      q(`INSERT INTO investment_project_status_history (project_id, from_status, to_status, actor_type, actor_id, reason, project_version, at) VALUES ($1, $2, $3, $4, $5, $6, $7, ${ago(when)})`, [id, from, to, actorType, actor, reason, version]);
    for (const [i, [title, loc, st, type, stage, target, ticket, status, version, visible, reason, interests]] of PROJECTS.entries()) {
      const owner = owners[i % 2], created = 55 - i * 7;
      const id = (await q(
        `INSERT INTO investment_project (owner_user_id, title, location, jurisdiction, project_type, summary, stage, funding_target_cents, minimum_ticket_cents, timeline, risks, structure_description, visible_to,
           issuer_name, issuer_licence_basis, issuer_statement, issuer_authorised_confirmed, status, version, review_reason, posting_model, commission_type, commission_bps, commission_fixed_cents, upfront_fee_cents, upfront_fee_status, model2_disclosure, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'Issuer statement supplied by the poster. Not reviewed or endorsed by the platform.', true, $16, $17, $18,
           'commission_on_contract', 'percent', 150, 0, 0, 'not_required', 'off', ${ago(created)}, ${ago(Math.max(created - 6, 1))}) RETURNING id`,
        [owner, title, loc, st, type, `${title}: a ${type.replace(/_/g, " ")} project in ${loc}. Example project for the local test kit; figures are illustrative only.`, stage, target * 100, ticket * 100,
          "Planning 6 months, build 14 months, sales and exit 6 months.", "Construction cost overruns, approval delays, softer sales prices and the usual risks of property development. Investors can lose some or all of their capital.",
          "Special purpose company; investors take a share through a subscription agreement. Off-platform; the platform holds no funds.", visible,
          `${title.split(" ")[0]} Developments Pty Ltd (demo)`, "Holds an Australian financial services licence (demo)", status, version, reason]))[0].id;
      await hist(id, null, "pending_review", "owner", owner, null, 1, created);
      if (status !== "pending_review") await hist(id, "pending_review", status, "staff", comp, reason, 1, created - 2);
      // Documents: current versions, and the plan replaced once (supersedes_id). Rows only; bytes arrive when a person uploads through the app.
      if (status !== "rejected") {
        let first = null;
        for (const [k, [kind, dtitle, vis]] of DOCS.entries()) {
          if (stage === "concept" && k > 1) continue;
          const did = randomUUID();
          await q(
            `INSERT INTO investment_project_document (id, project_id, kind, visibility, title, uploaded_by, content_type, size_bytes, sha256, storage_key, uploaded_at)
             VALUES ($1, $2, $3, $4, $5, $6, 'application/pdf', $7, $8, $9, ${ago(created - k)})`, [did, id, kind, vis, dtitle, owner, 180000 + k * 41000, sha(did), `investments/${id}/${did}`]);
          if (k === 0) first = did;
        }
        if (first && stage !== "concept") {
          const v2 = randomUUID();
          await q(`INSERT INTO investment_project_document (id, project_id, kind, visibility, title, uploaded_by, content_type, size_bytes, sha256, storage_key, supersedes_id, uploaded_at) VALUES ($1, $2, 'plan', 'investors', 'Site and floor plans (revised)', $3, 'application/pdf', 205000, $4, $5, $6, ${ago(created - 9)})`, [v2, id, owner, sha(v2), `investments/${id}/${v2}`, first]);
        }
      }
      // Interest, messages, signed contracts and fees (the first project shows every contract and fee state).
      for (let n = 0; n < interests; n++) {
        const inv = investors[n % investors.length];
        const cstatus = n === 0 ? "returned" : n === 1 ? "submitted" : "none";
        const lo = ticket * 100 * (n + 1);
        const iid = (await q(`INSERT INTO investment_interest (project_id, investor_user_id, amount_min_cents, amount_max_cents, contract_status, created_at) VALUES ($1, $2, $3, $4, $5, ${ago(30 - n * 5)}) RETURNING id`, [id, inv, lo, lo * 2, cstatus]))[0].id;
        await q(`INSERT INTO investment_message (interest_id, sender_user_id, body, sent_at) VALUES ($1, $2, 'Hi, I am interested in the project. Can you share the latest feasibility numbers and the expected timeline to exit?', ${ago(29 - n * 5)}), ($1, $3, 'Thanks for your interest. The feasibility study is in the documents list and I can walk you through it on a call this week.', ${ago(28 - n * 5)})`, [iid, inv, owner]);
        if (cstatus === "none") continue;
        const fid = randomUUID();
        await q(`INSERT INTO investment_contract_file (id, interest_id, uploaded_by, storage_key, sha256, size_bytes, uploaded_at) VALUES ($1, $2, $3, $4, $5, 96000, ${ago(14 - n * 3)})`, [fid, iid, inv, `investments/${iid.replace(/-/g, "")}/${fid.replace(/-/g, "")}`, sha(fid)]);
        await q(`INSERT INTO investment_contract_history (interest_id, from_status, to_status, actor_type, actor_id, reason, at) VALUES ($1, 'none', 'submitted', 'investor', $2, NULL, ${ago(14 - n * 3)})`, [iid, inv]);
        if (cstatus !== "returned") continue;
        await q(`INSERT INTO investment_contract_history (interest_id, from_status, to_status, actor_type, actor_id, reason, at) VALUES ($1, 'submitted', 'returned', 'staff', $2, 'Signed contract matches the project terms.', ${ago(12)})`, [iid, comp]);
        const feeId = (await q(`INSERT INTO investment_fee (interest_id, project_id, owner_user_id, amount_cents, status, created_at) VALUES ($1, $2, $3, $4, 'due', ${ago(12)}) RETURNING id`, [iid, id, owner, Math.round(lo * 0.015)]))[0].id;
        await q(`INSERT INTO investment_fee_history (fee_id, from_status, to_status, actor_id, reason, at) VALUES ($1, NULL, 'due', $2, 'Fee raised when the signed contract was returned.', ${ago(12)})`, [feeId, comp]);
        // First project: fee paid. Second project: fee waived. Anything else stays due.
        const settled = i === 0 ? ["paid", "Paid by bank transfer."] : i === 1 ? ["waived", "Waived for the launch month."] : null;
        if (settled) {
          await q(`UPDATE investment_fee SET status = $2 WHERE id = $1`, [feeId, settled[0]]);
          await q(`INSERT INTO investment_fee_history (fee_id, from_status, to_status, actor_id, reason, at) VALUES ($1, 'due', $2, $3, $4, ${ago(5)})`, [feeId, settled[0], boss, settled[1]]);
        }
      }
    }
    return "Admin demo: investor module (6 projects: 2 approved, 2 awaiting review, 1 changes requested, 1 rejected; interest, messages, contracts, fees, documents and posting settings).";
  });
}

export async function seedAdminExamples(db) {
  const P = await people(db);
  if (P.missing) { console.log(`Admin demo data skipped: base demo accounts are missing (${P.missing.join(", ")}).`); return; }
  await seedCoaching(db, P);
  await seedModeration(db, P);
  await seedInvestments(db, P);
}

// Standalone run (npm run seed:admin): same safety guard as seed-demo.mjs.
if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL is required."); process.exit(1); }
  if (process.env.NODE_ENV === "production") { console.error("Refusing to seed: NODE_ENV is production."); process.exit(2); }
  const host = new URL(url).hostname;
  if (host !== "localhost" && host !== "127.0.0.1") { console.error(`Refusing to seed: database host "${host}" is not localhost or 127.0.0.1.`); process.exit(2); }
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try { await seedAdminExamples(db); } catch { process.exitCode = 1; } finally { await db.end(); }
}
