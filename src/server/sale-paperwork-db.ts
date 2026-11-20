import { randomUUID } from "node:crypto";
import { STAGES, isStage } from "../domain/settlement";
import type { ItemRole } from "../domain/settlement";
import {
  CHASE, PAPERWORK_NOTE, buildChecklist, checkReminder, chaseItems, draftReminder, nextChaseStep, stoppedNote, summarise,
  type ChaseParty, type ChaseRow, type PaperFacts, type PaperItem, type PaperSummary
} from "../domain/sale-paperwork";
import type { PropertyListing } from "../domain/listing";
import { appendAuditPg, trustAccountDecisionPg, type Queryable } from "./db";
import { listingRequiredKeysPg } from "./disclosure-config-db";
import { notifyUser } from "./notifier";

// Constant SQL text; user input only travels as bound parameters. The log is insert-only (trigger). Nothing here deletes anything,
// accepts an offer or moves money.

const text = (v: unknown) => String(v);
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

export interface PaperSender { send(userId: string, title: string, body: string, link: string): Promise<boolean> }

/** Real delivery on the person's own notification settings (opt-outs are honoured at send time). */
export function createPaperSender(db: Queryable, env: Readonly<Record<string, string | undefined>> = process.env): PaperSender {
  return {
    async send(userId, title, body, link) {
      const r = await notifyUser(db, userId, "job_update", { title, text: body, link }, env);
      return r.inApp || r.email === "sent" || r.sms === "sent";
    }
  };
}

// ---- Settings ----------------------------------------------------------------------------------------------------------------------

export const GET_SETTINGS_SQL = "SELECT chase FROM elena_paperwork_settings WHERE listing_id = $1::uuid";
/** Only the listing's owner can change it: the owner check is part of the statement. */
export const SAVE_SETTINGS_SQL =
  `INSERT INTO elena_paperwork_settings (listing_id, chase, updated_by)
   SELECT l.id, $3::boolean, $2::uuid FROM property_listing l WHERE l.id = $1::uuid AND l.owner_user_id = $2::uuid
   ON CONFLICT (listing_id) DO UPDATE SET chase = EXCLUDED.chase, updated_by = EXCLUDED.updated_by, updated_at = now()
   RETURNING listing_id`;

export async function getChaseSetting(db: Queryable, listingId: string): Promise<boolean> {
  return (await db.query(GET_SETTINGS_SQL, [listingId])).rows[0]?.["chase"] === true;
}
export async function saveChaseSetting(db: Queryable, ownerId: string, listingId: string, chase: boolean): Promise<boolean> {
  const ok = (await db.query(SAVE_SETTINGS_SQL, [listingId, ownerId, chase])).rows.length === 1;
  if (ok) await audit(db, ownerId, listingId, "paperwork.chase_setting", { chase });
  return ok;
}

async function audit(db: Queryable, actorId: string | null, listingId: string, eventType: string, payload: Record<string, unknown>) {
  await appendAuditPg(db, {
    id: randomUUID(), occurredAt: new Date().toISOString(), actorType: actorId ? "user" : "system", actorId: actorId ?? "elena-paperwork",
    aggregateType: "listing", aggregateId: listingId, eventType, correlationId: randomUUID(), payload
  });
}

// ---- Facts -------------------------------------------------------------------------------------------------------------------------

const LISTING_SQL = "SELECT id, owner_user_id, jurisdiction, transaction_type, use_class, property_type, status, address_text FROM property_listing WHERE id = $1::uuid";
const DISCLOSURES_SQL = "SELECT disclosure_key, satisfied FROM listing_disclosure WHERE listing_id = $1::uuid";
const SIGNING_SQL = "SELECT status FROM signing_document WHERE listing_id = $1::uuid ORDER BY created_at DESC, id LIMIT 1";
const FILES_SQL = "SELECT DISTINCT kind FROM property_document WHERE listing_id = $1::uuid AND kind IN ('contract','building_inspection','pest_report') AND status = 'active'";
/** The sale in progress: the accepted offer's tracker, not finished, not fallen through. */
const SALE_SQL =
  `SELECT t.id, t.buyer_id, t.current_stage, v.id_verified_at
     FROM settlement_timeline t JOIN formal_offer o ON o.id = t.offer_id LEFT JOIN buyer_verification v ON v.user_id = t.buyer_id
    WHERE t.listing_id = $1::uuid AND t.completed_at IS NULL AND o.status = 'accepted'
    ORDER BY t.created_at DESC LIMIT 1`;
const CHECKLIST_SQL =
  `SELECT c.milestone_stage, c.role, c.items, m.status AS milestone_status
     FROM settlement_checklists c JOIN settlement_milestones m ON m.settlement_id = c.settlement_id AND m.stage = c.milestone_stage
    WHERE c.settlement_id = $1::uuid`;

export interface ListingBasics { id: string; ownerUserId: string; address: string; published: boolean }
export interface PaperworkData { basics: ListingBasics; facts: PaperFacts; items: PaperItem[]; saleInProgress: boolean; summary: PaperSummary; sale?: { settlementId: string; buyerId: string } }

export async function loadPaperwork(db: Queryable, listingId: string): Promise<PaperworkData | undefined> {
  const l = (await db.query(LISTING_SQL, [listingId])).rows[0];
  if (!l) return undefined;
  const listing = { id: text(l["id"]), jurisdiction: text(l["jurisdiction"]).trim(), transactionType: text(l["transaction_type"]), useClass: text(l["use_class"]), propertyType: text(l["property_type"]) } as unknown as PropertyListing;
  const [required, disc, trust, signing, files, saleRow] = await Promise.all([
    listingRequiredKeysPg(db, listing), db.query(DISCLOSURES_SQL, [listingId]), trustAccountDecisionPg(db, listingId),
    db.query(SIGNING_SQL, [listingId]), db.query(FILES_SQL, [listingId]), db.query(SALE_SQL, [listingId])
  ]);
  const kinds = new Set(files.rows.map(r => text(r["kind"])));
  const s = saleRow.rows[0];
  const facts: PaperFacts = {
    listingPublished: text(l["status"]) === "published", requiredDisclosures: required,
    disclosures: disc.rows.map(r => ({ key: text(r["disclosure_key"]), satisfied: r["satisfied"] === true })),
    trustAccountApproved: trust?.kind === "approved", contractFileUploaded: kinds.has("contract"),
    buildingReport: kinds.has("building_inspection"), pestReport: kinds.has("pest_report")
  };
  const sig = signing.rows[0]?.["status"];
  if (typeof sig === "string") facts.contractSigning = sig as NonNullable<PaperFacts["contractSigning"]>;
  let sale: PaperworkData["sale"];
  if (s) {
    const current = text(s["current_stage"]);
    const rows = (await db.query(CHECKLIST_SQL, [text(s["id"])])).rows;
    const items: NonNullable<PaperFacts["sale"]>["items"][number][] = [];
    for (const r of rows) {
      const stage = text(r["milestone_stage"]);
      const stageDone = text(r["milestone_status"]) === "completed";
      const upcoming = isStage(stage) && isStage(current) && STAGES.indexOf(stage) > STAGES.indexOf(current);
      for (const it of Array.isArray(r["items"]) ? (r["items"] as Record<string, unknown>[]) : []) {
        items.push({ stage, role: text(r["role"]) as ItemRole, itemId: text(it["id"]), label: text(it["label"]), done: stageDone || it["done"] === true, upcoming });
      }
    }
    items.sort((a, b) => STAGES.indexOf(a.stage as never) - STAGES.indexOf(b.stage as never) || a.role.localeCompare(b.role) || a.itemId.localeCompare(b.itemId));
    facts.sale = { settlementId: text(s["id"]), buyerIdVerified: s["id_verified_at"] != null, items };
    sale = { settlementId: text(s["id"]), buyerId: text(s["buyer_id"]) };
  }
  const list = buildChecklist(facts);
  return {
    basics: { id: listingId, ownerUserId: text(l["owner_user_id"]), address: text(l["address_text"]), published: facts.listingPublished },
    facts, items: list, saleInProgress: sale !== undefined, summary: summarise(list, sale !== undefined), ...(sale ? { sale } : {})
  };
}

// ---- Owner view --------------------------------------------------------------------------------------------------------------------

export interface PaperLogEntry { id: string; party: ChaseParty; kind: string; body: string; status: string; reason?: string; at: string }
const LOG_LIST_SQL = "SELECT id, party, kind, body, status, reason, created_at FROM elena_paperwork_message WHERE listing_id = $1::uuid ORDER BY created_at DESC, id LIMIT 40";
const CHASES_SQL = "SELECT party, state, reminders, next_action_at FROM elena_paperwork_chase WHERE listing_id = $1::uuid";

export interface PaperworkView {
  items: PaperItem[]; summary: PaperSummary; saleInProgress: boolean; chase: boolean;
  chases: { party: ChaseParty; state: string; reminders: number; nextActionAt: string }[]; log: PaperLogEntry[]; note: string;
}

export async function paperworkView(db: Queryable, listingId: string, data: PaperworkData): Promise<PaperworkView> {
  const [chase, chases, log] = await Promise.all([getChaseSetting(db, listingId), db.query(CHASES_SQL, [listingId]), db.query(LOG_LIST_SQL, [listingId])]);
  return {
    items: data.items, summary: data.summary, saleInProgress: data.saleInProgress, chase, note: PAPERWORK_NOTE,
    chases: chases.rows.map(r => ({ party: text(r["party"]) as ChaseParty, state: text(r["state"]), reminders: Number(r["reminders"]), nextActionAt: iso(r["next_action_at"]) })),
    log: log.rows.map(r => ({ id: text(r["id"]), party: text(r["party"]) as ChaseParty, kind: text(r["kind"]), body: text(r["body"]), status: text(r["status"]), ...(r["reason"] ? { reason: text(r["reason"]) } : {}), at: iso(r["created_at"]) }))
  };
}

// ---- Reminders ---------------------------------------------------------------------------------------------------------------------

const LOG_SQL = "INSERT INTO elena_paperwork_message (id, listing_id, party, kind, body, status, reason) VALUES ($1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text, $7)";
const SENT_SQL = "SELECT count(*) AS n FROM elena_paperwork_message WHERE listing_id = $1::uuid AND party = $2::text AND kind = 'reminder' AND status = 'sent' AND created_at > $3::timestamptz";
const CHASE_ROW_SQL = "SELECT state, reminders, next_action_at FROM elena_paperwork_chase WHERE listing_id = $1::uuid AND party = $2::text";
const CHASE_START_SQL =
  `INSERT INTO elena_paperwork_chase (listing_id, party, state, reminders, next_action_at) VALUES ($1::uuid, $2::text, 'active', 0, $3::timestamptz)
   ON CONFLICT (listing_id, party) DO UPDATE SET state = 'active', reminders = 0, next_action_at = EXCLUDED.next_action_at, updated_at = now()
   WHERE elena_paperwork_chase.state = 'done'`;
/** Claims one reminder: only the run that still sees the old count wins, so two overlapping runs cannot both send. */
const CLAIM_SQL =
  `UPDATE elena_paperwork_chase SET reminders = reminders + 1, last_sent_at = $4::timestamptz, next_action_at = $5::timestamptz, updated_at = now()
   WHERE listing_id = $1::uuid AND party = $2::text AND state = 'active' AND reminders = $3::int RETURNING reminders`;
const CLOSE_SQL = "UPDATE elena_paperwork_chase SET state = $3::text, updated_at = now() WHERE listing_id = $1::uuid AND party = $2::text AND state = 'active' RETURNING party";
const NAME_SQL = "SELECT display_name FROM app_user WHERE id = $1::uuid";
const DUE_LISTINGS_SQL = "SELECT listing_id FROM elena_paperwork_settings WHERE chase = true";

/** The owner reads this log, so a reminder to the buyer is stored without the buyer's name (owners never see buyer identity). */
const log = (db: Queryable, listingId: string, party: ChaseParty, kind: "reminder" | "stopped", body: string, status: string, reason?: string) =>
  db.query(LOG_SQL, [randomUUID(), listingId, party, kind, (party === "buyer" ? body.replace(/^Hi [^,\n]*,/, "Hi there,") : body).slice(0, 2000) || "(empty)", status, reason ?? null]);

export interface PaperTick { listings: number; sent: number; stopped: number; done: number }
const addMs = (now: string, ms: number) => new Date(Date.parse(now) + ms).toISOString();

/**
 * One scheduler pass. For each listing whose owner switched Elena on and that has a sale in progress, she reminds the owner and the accepted buyer
 * about the blocking items on their own side, one message per person at most once a day and three in all, and stops when they are done (or after
 * the third reminder, telling the owner). Every message is content-checked and logged; a blocked or rate-limited one is never sent.
 * A person only ever hears about their own items: the buyer never sees the owner's list or any offer terms, and the owner is not shown the buyer's details.
 */
export async function runDuePaperwork(db: Queryable, now: string, sender: PaperSender = createPaperSender(db)): Promise<PaperTick> {
  const tick: PaperTick = { listings: 0, sent: 0, stopped: 0, done: 0 };
  const ids = (await db.query(DUE_LISTINGS_SQL)).rows.map(r => text(r["listing_id"]));
  for (const listingId of ids) {
    try {
      const data = await loadPaperwork(db, listingId);
      if (!data || !data.sale) continue;
      tick.listings++;
      for (const party of ["owner", "buyer"] as const) {
        const open = chaseItems(data.items, party, data.saleInProgress);
        const r = (await db.query(CHASE_ROW_SQL, [listingId, party])).rows[0];
        let row: ChaseRow | undefined = r ? { state: text(r["state"]) as ChaseRow["state"], reminders: Number(r["reminders"]), nextActionAt: iso(r["next_action_at"]) } : undefined;
        // A first sighting, or new open work after a finished run, starts the clock; the first reminder is a day away so nobody is chased the minute a stage opens.
        if ((!row || row.state === "done") && open.length > 0) {
          await db.query(CHASE_START_SQL, [listingId, party, addMs(now, CHASE.firstAfterMs)]);
          row = { state: "active", reminders: 0, nextActionAt: addMs(now, CHASE.firstAfterMs) };
        }
        const step = nextChaseStep(row, open.length, now);
        if (step.kind === "done") { if ((await db.query(CLOSE_SQL, [listingId, party, "done"])).rows.length) tick.done++; continue; }
        const ownerId = data.basics.ownerUserId, buyerId = data.sale.buyerId;
        const toId = party === "owner" ? ownerId : buyerId;
        const link = party === "owner" ? `/listings/${listingId}/paperwork` : `/settlements/${data.sale.settlementId}`;
        if (step.kind === "stop") {
          if (!(await db.query(CLOSE_SQL, [listingId, party, "stopped"])).rows.length) continue;
          const d = stoppedNote(data.basics.address, party);
          const ok = await sender.send(ownerId, d.title, d.body, `/listings/${listingId}/paperwork`).catch(() => false);
          await log(db, listingId, "owner", "stopped", d.body, ok ? "sent" : "failed", ok ? undefined : "Delivery failed.");
          await audit(db, null, listingId, "paperwork.chase_stopped", { party, open: open.length });
          tick.stopped++;
          continue;
        }
        if (step.kind !== "send") continue;
        const name = text((await db.query(NAME_SQL, [toId])).rows[0]?.["display_name"] ?? "");
        const draft = draftReminder({ to: name, address: data.basics.address, labels: open.map(i => i.label), reminderNo: step.reminderNo, party });
        const check = checkReminder(draft);
        const claimed = (await db.query(CLAIM_SQL, [listingId, party, step.reminderNo - 1, now, addMs(now, CHASE.gapMs)])).rows.length === 1;
        if (!claimed) continue;
        if (!check.ok) { await log(db, listingId, party, "reminder", draft.body, "blocked", check.reason); continue; }
        const recent = Number((await db.query(SENT_SQL, [listingId, party, addMs(now, -24 * 3600_000)])).rows[0]?.["n"] ?? 0);
        if (recent >= CHASE.maxPerPartyPerDay) { await log(db, listingId, party, "reminder", draft.body, "rate_limited", "Daily message limit for this person on this listing."); continue; }
        const ok = await sender.send(toId, draft.title, draft.body, link).catch(() => false);
        await log(db, listingId, party, "reminder", draft.body, ok ? "sent" : "failed", ok ? undefined : "Delivery failed.");
        if (ok) { tick.sent++; await audit(db, null, listingId, "paperwork.reminder_sent", { party, reminderNo: step.reminderNo, items: open.length }); }
      }
    } catch { /* one listing never stops the others; the next pass tries again */ }
  }
  return tick;
}
