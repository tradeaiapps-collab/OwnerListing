import { createHash, randomUUID } from "node:crypto";
import { malwareScannerFromEnv } from "../adapters/malware-scan";
import { objectStorageFromEnv } from "../adapters/object-storage";
import { createWestpacPayway, paywayConfigFromEnv } from "../adapters/westpac-payway";
import { createInvoice } from "../domain/billing";
import type {
  ContractChange, ContractFile, Fee, FeeChange, Interest, InvestmentCounts, InvestmentDeps, InvestmentMessage, InvestmentRepository, StatusChange, ThreadItem
} from "../domain/investment-service";
import { DEFAULT_POSTING, validatePostingSettings, type PostingSettings } from "../domain/investment-terms";
import { envMasterOn, moduleState, type InvestmentProject, type InvestorDeclaration, type ModuleState, type ToggleRequest } from "../domain/investor-projects";
import { hashToken } from "../domain/offer-intake";
import { windowStart } from "../domain/rate-limit";
import type { StaffActor } from "../domain/staff-access";
import { getDb } from "./context";
import { appendAuditPg, type Queryable } from "./db";
import { getBuyerVerification } from "./enquiry-db";
import { getEmailPort } from "./messaging";
import { countHitPg } from "./offer-flow-db";

// Constant SQL only; user input travels as bound parameters. No UPDATE/DELETE on the insert-only tables (db triggers refuse them too).
type Env = Readonly<Record<string, string | undefined>>;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const n = (v: unknown) => Number(v);

/** Env key first: when it is off the database is never read. Any database error = off (fail closed). */
export async function readModuleState(env: Env, db: () => Queryable): Promise<ModuleState> {
  if (!envMasterOn(env)) return moduleState(false, false);
  try {
    const r = await db().query("SELECT enabled FROM investment_setting WHERE key = 'investment_module_enabled'");
    return moduleState(true, r.rows[0]?.["enabled"] === true);
  } catch {
    return moduleState(true, false);
  }
}

export interface SettingChange { enabled: boolean; counselConfirmed: boolean; disclosureVersion: string; changedBy: string; changedAt: string }

/** Database key value (regardless of env) and the change history, newest first. */
export async function loadSetting(db: Queryable): Promise<{ dbOn: boolean; history: SettingChange[] }> {
  const s = await db.query("SELECT enabled FROM investment_setting WHERE key = 'investment_module_enabled'");
  const h = await db.query("SELECT enabled, counsel_confirmed, disclosure_version, changed_by, changed_at FROM investment_setting_history ORDER BY changed_at DESC LIMIT 50");
  return {
    dbOn: s.rows[0]?.["enabled"] === true,
    history: h.rows.map(r => ({ enabled: r["enabled"] === true, counselConfirmed: r["counsel_confirmed"] === true, disclosureVersion: String(r["disclosure_version"]), changedBy: String(r["changed_by"]), changedAt: iso(r["changed_at"]) }))
  };
}

/** Sets the database key, its history row and an audit event in one transaction. Takes effect on the next request. */
export async function saveToggle(db: Queryable, staff: StaffActor, t: ToggleRequest): Promise<void> {
  if (!db.transaction) throw new Error("Transactions are required.");
  const now = new Date().toISOString();
  await db.transaction(async tx => {
    await tx.query(
      `INSERT INTO investment_setting (key, enabled, updated_by, updated_at) VALUES ('investment_module_enabled', $1, $2::uuid, $3::timestamptz)
       ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
      [t.enabled, staff.id, now]);
    await tx.query(
      "INSERT INTO investment_setting_history (enabled, counsel_confirmed, disclosure_version, changed_by, changed_at) VALUES ($1, $2, $3, $4::uuid, $5::timestamptz)",
      [t.enabled, t.counselConfirmed, t.disclosureVersion, staff.id, now]);
    await appendAuditPg(tx, {
      id: randomUUID(), occurredAt: now, actorType: "user", actorId: staff.id, aggregateType: "investment_settings", aggregateId: "investment_module_enabled",
      eventType: t.enabled ? "investment.module_enabled" : "investment.module_disabled", correlationId: randomUUID(),
      payload: { role: staff.role, counselConfirmed: t.counselConfirmed, disclosureVersion: t.disclosureVersion }
    });
  });
}

/** Posting model settings; defaults when never saved. A stored row that no longer validates throws (posting is then refused). */
export async function loadPosting(db: Queryable): Promise<PostingSettings> {
  const r = await db.query("SELECT model, commission_type, commission_bps, commission_fixed_cents, upfront_fee_cents, model2_disclosure FROM investment_posting_setting WHERE key = 'posting'");
  const row = r.rows[0];
  if (!row) return { ...DEFAULT_POSTING };
  const v = validatePostingSettings({
    model: row["model"], commissionType: row["commission_type"], commissionBps: n(row["commission_bps"]), commissionFixedCents: n(row["commission_fixed_cents"]),
    upfrontFeeCents: n(row["upfront_fee_cents"]), model2Disclosure: row["model2_disclosure"]
  });
  if (!v.ok) throw new Error("Stored posting settings are invalid.");
  return v.value;
}

export async function loadPostingHistory(db: Queryable) {
  const h = await db.query("SELECT settings, changed_by, changed_at FROM investment_posting_setting_history ORDER BY changed_at DESC LIMIT 50");
  return h.rows.map(r => ({ settings: r["settings"] as PostingSettings, changedBy: String(r["changed_by"]), changedAt: iso(r["changed_at"]) }));
}

export async function savePosting(db: Queryable, staff: StaffActor, s: PostingSettings): Promise<void> {
  if (!db.transaction) throw new Error("Transactions are required.");
  const now = new Date().toISOString();
  await db.transaction(async tx => {
    await tx.query(
      `INSERT INTO investment_posting_setting (key, model, commission_type, commission_bps, commission_fixed_cents, upfront_fee_cents, model2_disclosure, updated_by, updated_at)
       VALUES ('posting', $1, $2, $3, $4, $5, $6, $7::uuid, $8::timestamptz)
       ON CONFLICT (key) DO UPDATE SET model = EXCLUDED.model, commission_type = EXCLUDED.commission_type, commission_bps = EXCLUDED.commission_bps,
         commission_fixed_cents = EXCLUDED.commission_fixed_cents, upfront_fee_cents = EXCLUDED.upfront_fee_cents, model2_disclosure = EXCLUDED.model2_disclosure,
         updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
      [s.model, s.commissionType, s.commissionBps, s.commissionFixedCents, s.upfrontFeeCents, s.model2Disclosure, staff.id, now]);
    await tx.query("INSERT INTO investment_posting_setting_history (settings, changed_by, changed_at) VALUES ($1::jsonb, $2::uuid, $3::timestamptz)", [JSON.stringify(s), staff.id, now]);
    await appendAuditPg(tx, {
      id: randomUUID(), occurredAt: now, actorType: "user", actorId: staff.id, aggregateType: "investment_settings", aggregateId: "posting",
      eventType: "investment.posting_settings_changed", correlationId: randomUUID(), payload: { role: staff.role, ...s }
    });
  });
}

const COLS = `id, owner_user_id, title, location, jurisdiction, project_type, summary, stage, funding_target_cents, minimum_ticket_cents, timeline, risks,
  structure_description, visible_to, issuer_name, issuer_licence_basis, issuer_statement, issuer_authorised_confirmed, status, version, review_reason, created_at, updated_at,
  posting_model, commission_type, commission_bps, commission_fixed_cents, upfront_fee_cents, upfront_fee_status`;

const toProject = (r: Record<string, unknown>): InvestmentProject => ({
  id: String(r["id"]), ownerUserId: String(r["owner_user_id"]), title: String(r["title"]), location: String(r["location"]),
  jurisdiction: String(r["jurisdiction"]).trim() as InvestmentProject["jurisdiction"], projectType: r["project_type"] as InvestmentProject["projectType"],
  summary: String(r["summary"]), stage: r["stage"] as InvestmentProject["stage"], fundingTargetCents: n(r["funding_target_cents"]),
  minimumTicketCents: n(r["minimum_ticket_cents"]), timeline: String(r["timeline"]), risks: String(r["risks"]),
  structureDescription: String(r["structure_description"]), visibleTo: r["visible_to"] as InvestmentProject["visibleTo"], issuerName: String(r["issuer_name"]),
  issuerLicenceBasis: String(r["issuer_licence_basis"]), issuerStatement: String(r["issuer_statement"]), issuerAuthorisedConfirmed: true,
  status: r["status"] as InvestmentProject["status"], version: n(r["version"]),
  terms: {
    model: r["posting_model"] as InvestmentProject["terms"]["model"], commissionType: r["commission_type"] as InvestmentProject["terms"]["commissionType"],
    commissionBps: n(r["commission_bps"]), commissionFixedCents: n(r["commission_fixed_cents"]), upfrontFeeCents: n(r["upfront_fee_cents"]),
    upfrontFeeStatus: r["upfront_fee_status"] as InvestmentProject["terms"]["upfrontFeeStatus"]
  },
  ...(r["review_reason"] != null ? { reviewReason: String(r["review_reason"]) } : {}),
  createdAt: iso(r["created_at"]), updatedAt: iso(r["updated_at"])
});
const INTEREST_COLS = "i.id, i.project_id, i.investor_user_id, i.amount_min_cents, i.amount_max_cents, i.created_at, i.contract_status";
const toInterest = (r: Record<string, unknown>): Interest => ({
  id: String(r["id"]), projectId: String(r["project_id"]), investorUserId: String(r["investor_user_id"]),
  amountMinCents: n(r["amount_min_cents"]), amountMaxCents: n(r["amount_max_cents"]), createdAt: iso(r["created_at"]),
  contractStatus: r["contract_status"] as Interest["contractStatus"]
});
const toFile = (r: Record<string, unknown>): ContractFile => ({
  id: String(r["id"]), interestId: String(r["interest_id"]), uploadedBy: String(r["uploaded_by"]), storageKey: String(r["storage_key"]),
  sha256: String(r["sha256"]), sizeBytes: n(r["size_bytes"]), uploadedAt: iso(r["uploaded_at"])
});
const toFee = (r: Record<string, unknown>): Fee => ({
  id: String(r["id"]), interestId: String(r["interest_id"]), projectId: String(r["project_id"]), ownerUserId: String(r["owner_user_id"]),
  amountCents: n(r["amount_cents"]), status: r["status"] as Fee["status"], createdAt: iso(r["created_at"])
});

const fieldParams = (p: InvestmentProject) => [p.title, p.location, p.jurisdiction, p.projectType, p.summary, p.stage, p.fundingTargetCents, p.minimumTicketCents,
  p.timeline, p.risks, p.structureDescription, p.visibleTo, p.issuerName, p.issuerLicenceBasis, p.issuerStatement];

async function addHistory(db: Queryable, h: StatusChange) {
  await db.query(
    `INSERT INTO investment_project_status_history (id, project_id, from_status, to_status, actor_type, actor_id, reason, project_version, at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7, $8, $9::timestamptz)`,
    [h.id, h.projectId, h.fromStatus, h.toStatus, h.actorType, h.actorId, h.reason, h.projectVersion, h.at]);
}
async function addFeeHistory(db: Queryable, c: FeeChange) {
  await db.query("INSERT INTO investment_fee_history (id, fee_id, from_status, to_status, actor_id, reason, at) VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6, $7::timestamptz)",
    [c.id, c.feeId, c.fromStatus, c.toStatus, c.actorId, c.reason, c.at]);
}

const tx = <T>(db: Queryable, fn: (q: Queryable) => Promise<T>) => (db.transaction ? db.transaction(fn) : fn(db));

export function createPgInvestmentRepository(db: Queryable): InvestmentRepository {
  return {
    createProject: (p, h) => tx(db, async q => {
      const t = p.terms;
      await q.query(
        `INSERT INTO investment_project (id, owner_user_id, title, location, jurisdiction, project_type, summary, stage, funding_target_cents, minimum_ticket_cents,
           timeline, risks, structure_description, visible_to, issuer_name, issuer_licence_basis, issuer_statement, issuer_authorised_confirmed, status, version, created_at, updated_at,
           posting_model, commission_type, commission_bps, commission_fixed_cents, upfront_fee_cents, upfront_fee_status)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, true, 'pending_review', 1, $18::timestamptz, $18::timestamptz,
           $19, $20, $21, $22, $23, $24)`,
        [p.id, p.ownerUserId, ...fieldParams(p), p.createdAt, t.model, t.commissionType, t.commissionBps, t.commissionFixedCents, t.upfrontFeeCents, t.upfrontFeeStatus]);
      await addHistory(q, h);
    }),
    // Posting terms are deliberately not in the SET list: they stay as first posted.
    updateProject: (p, v, h) => tx(db, async q => {
      const r = await q.query(
        `UPDATE investment_project SET title = $3, location = $4, jurisdiction = $5, project_type = $6, summary = $7, stage = $8, funding_target_cents = $9,
           minimum_ticket_cents = $10, timeline = $11, risks = $12, structure_description = $13, visible_to = $14, issuer_name = $15, issuer_licence_basis = $16,
           issuer_statement = $17, status = 'pending_review', review_reason = NULL, version = version + 1, updated_at = $18::timestamptz
         WHERE id = $1::uuid AND version = $2 AND status <> 'rejected' RETURNING id`,
        [p.id, v, ...fieldParams(p), p.updatedAt]);
      if (r.rows.length !== 1) return false;
      await addHistory(q, h);
      return true;
    }),
    decide: (id, v, status, reason, h) => tx(db, async q => {
      const r = await q.query(
        `UPDATE investment_project SET status = $3, review_reason = $4, updated_at = $5::timestamptz
         WHERE id = $1::uuid AND version = $2 AND status = 'pending_review' RETURNING id`,
        [id, v, status, reason, h.at]);
      if (r.rows.length !== 1) return false;
      await addHistory(q, h);
      return true;
    }),
    async getProject(id) {
      const r = await db.query(`SELECT ${COLS} FROM investment_project WHERE id = $1::uuid`, [id]);
      return r.rows[0] ? toProject(r.rows[0]) : undefined;
    },
    async listByStatus(s) {
      const r = await db.query(`SELECT ${COLS} FROM investment_project WHERE status = $1 ORDER BY updated_at DESC LIMIT 200`, [s]);
      return r.rows.map(toProject);
    },
    async listByOwner(o) {
      const r = await db.query(`SELECT ${COLS} FROM investment_project WHERE owner_user_id = $1::uuid ORDER BY updated_at DESC LIMIT 200`, [o]);
      return r.rows.map(toProject);
    },
    async latestDeclaration(u) {
      const r = await db.query("SELECT user_id, category, disclosure_version, declared_at FROM investor_declaration WHERE user_id = $1::uuid ORDER BY declared_at DESC, id DESC LIMIT 1", [u]);
      const row = r.rows[0];
      return row ? { userId: String(row["user_id"]), category: row["category"] as InvestorDeclaration["category"], disclosureVersion: String(row["disclosure_version"]), declaredAt: iso(row["declared_at"]) } : undefined;
    },
    async addDeclaration(d) {
      await db.query(
        `INSERT INTO investor_declaration (id, user_id, category, ack_not_advice, ack_not_offer, ack_no_funds_held, ack_off_platform, disclosure_version, declared_at)
         VALUES ($1::uuid, $2::uuid, $3, true, true, true, true, $4, $5::timestamptz)`,
        [d.id, d.userId, d.category, d.disclosureVersion, d.declaredAt]);
    },
    async findInterest(pid, u) {
      const r = await db.query(`SELECT ${INTEREST_COLS} FROM investment_interest i WHERE i.project_id = $1::uuid AND i.investor_user_id = $2::uuid`, [pid, u]);
      return r.rows[0] ? toInterest(r.rows[0]) : undefined;
    },
    async getInterest(id) {
      const r = await db.query(`SELECT ${INTEREST_COLS} FROM investment_interest i WHERE i.id = $1::uuid`, [id]);
      return r.rows[0] ? toInterest(r.rows[0]) : undefined;
    },
    addInterest: (i, m) => tx(db, async q => {
      await q.query(
        "INSERT INTO investment_interest (id, project_id, investor_user_id, amount_min_cents, amount_max_cents, created_at) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::timestamptz)",
        [i.id, i.projectId, i.investorUserId, i.amountMinCents, i.amountMaxCents, i.createdAt]);
      await q.query("INSERT INTO investment_message (id, interest_id, sender_user_id, body, sent_at) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz)",
        [m.id, m.interestId, m.senderUserId, m.body, m.sentAt]);
    }),
    async threadsFor(u): Promise<ThreadItem[]> {
      const r = await db.query(
        `SELECT ${INTEREST_COLS}, p.title, CASE WHEN i.investor_user_id = $1::uuid THEN 'investor' ELSE 'owner' END AS role
           FROM investment_interest i JOIN investment_project p ON p.id = i.project_id
          WHERE i.investor_user_id = $1::uuid OR p.owner_user_id = $1::uuid ORDER BY i.created_at DESC LIMIT 200`, [u]);
      return r.rows.map(row => ({ interest: toInterest(row), projectTitle: String(row["title"]), role: row["role"] === "investor" ? "investor" : "owner" }));
    },
    async addMessage(m) {
      await db.query("INSERT INTO investment_message (id, interest_id, sender_user_id, body, sent_at) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz)",
        [m.id, m.interestId, m.senderUserId, m.body, m.sentAt]);
    },
    async messages(id): Promise<InvestmentMessage[]> {
      const r = await db.query("SELECT id, interest_id, sender_user_id, body, sent_at FROM investment_message WHERE interest_id = $1::uuid ORDER BY sent_at, id LIMIT 1000", [id]);
      return r.rows.map(x => ({ id: String(x["id"]), interestId: String(x["interest_id"]), senderUserId: String(x["sender_user_id"]), body: String(x["body"]), sentAt: iso(x["sent_at"]) }));
    },
    changeContract: (c: ContractChange, file?: ContractFile, fee?: { fee: Fee; change: FeeChange }) => tx(db, async q => {
      const r = await q.query("UPDATE investment_interest SET contract_status = $3 WHERE id = $1::uuid AND contract_status = $2 RETURNING id", [c.interestId, c.fromStatus, c.toStatus]);
      if (r.rows.length !== 1) return false;
      await q.query(
        "INSERT INTO investment_contract_history (id, interest_id, from_status, to_status, actor_type, actor_id, reason, at) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7, $8::timestamptz)",
        [c.id, c.interestId, c.fromStatus, c.toStatus, c.actorType, c.actorId, c.reason, c.at]);
      if (file) {
        await q.query("INSERT INTO investment_contract_file (id, interest_id, uploaded_by, storage_key, sha256, size_bytes, uploaded_at) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::timestamptz)",
          [file.id, file.interestId, file.uploadedBy, file.storageKey, file.sha256, file.sizeBytes, file.uploadedAt]);
      }
      if (fee) {
        const f = fee.fee;
        await q.query("INSERT INTO investment_fee (id, interest_id, project_id, owner_user_id, amount_cents, status, created_at) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'due', $6::timestamptz)",
          [f.id, f.interestId, f.projectId, f.ownerUserId, f.amountCents, f.createdAt]);
        await addFeeHistory(q, fee.change);
      }
      return true;
    }),
    async listContracts(s) {
      const r = await db.query(
        `SELECT ${INTEREST_COLS}, p.title FROM investment_interest i JOIN investment_project p ON p.id = i.project_id WHERE i.contract_status = $1 ORDER BY i.created_at LIMIT 200`, [s]);
      const out = [];
      for (const row of r.rows) {
        const file = await this.latestContractFile(String(row["id"]));
        out.push({ interest: toInterest(row), projectTitle: String(row["title"]), ...(file ? { file } : {}) });
      }
      return out;
    },
    async latestContractFile(id) {
      const r = await db.query("SELECT id, interest_id, uploaded_by, storage_key, sha256, size_bytes, uploaded_at FROM investment_contract_file WHERE interest_id = $1::uuid ORDER BY uploaded_at DESC, id DESC LIMIT 1", [id]);
      return r.rows[0] ? toFile(r.rows[0]) : undefined;
    },
    async getFee(id) {
      const r = await db.query("SELECT * FROM investment_fee WHERE id = $1::uuid", [id]);
      return r.rows[0] ? toFee(r.rows[0]) : undefined;
    },
    async listFees(q) {
      const r = q.ownerUserId
        ? await db.query("SELECT * FROM investment_fee WHERE owner_user_id = $1::uuid ORDER BY created_at DESC LIMIT 200", [q.ownerUserId])
        : await db.query("SELECT * FROM investment_fee ORDER BY created_at DESC LIMIT 200");
      return r.rows.map(toFee);
    },
    changeFee: c => tx(db, async q => {
      const r = await q.query("UPDATE investment_fee SET status = $3 WHERE id = $1::uuid AND status = $2 RETURNING id", [c.feeId, c.fromStatus, c.toStatus]);
      if (r.rows.length !== 1) return false;
      await addFeeHistory(q, c);
      return true;
    }),
    async counts(): Promise<InvestmentCounts> {
      const r = await db.query(
        `SELECT (SELECT count(*) FROM investment_project WHERE status = 'pending_review') AS pending_review,
                (SELECT count(*) FROM investment_project WHERE status = 'approved') AS approved,
                (SELECT count(*) FROM investment_project WHERE status = 'changes_requested') AS changes_requested,
                (SELECT count(*) FROM investment_project WHERE status = 'rejected') AS rejected,
                (SELECT count(*) FROM investment_interest) AS interests,
                (SELECT count(DISTINCT user_id) FROM investor_declaration) AS declarations,
                (SELECT count(*) FROM investment_interest WHERE contract_status = 'submitted') AS contracts,
                (SELECT count(*) FROM investment_fee WHERE status = 'due') AS fees`);
      const c = r.rows[0] ?? {};
      return {
        pending_review: n(c["pending_review"]), approved: n(c["approved"]), changes_requested: n(c["changes_requested"]), rejected: n(c["rejected"]),
        interests: n(c["interests"]), declarations: n(c["declarations"]), contractsSubmitted: n(c["contracts"]), feesDue: n(c["fees"])
      };
    }
  };
}

/** Name and email, only ever used after Model 2 disclosure has unlocked. */
async function contactPg(db: Queryable, userId: string) {
  const r = await db.query("SELECT display_name, email FROM app_user WHERE id = $1::uuid", [userId]);
  const row = r.rows[0];
  return row && typeof row["email"] === "string" ? { name: String(row["display_name"]), email: row["email"] } : undefined;
}

/** Platform-address email through the messaging outbox. Fails quietly (the outbox records it); the address is read only once email is configured. */
async function notifyPg(db: Queryable, env: Env, userId: string, template: string, subject: string, text: string) {
  try {
    const port = await getEmailPort(db, env, template);
    if (!port.configured) return;
    const to = (await contactPg(db, userId))?.email;
    if (to) await port.send({ to, subject, text });
  } catch { /* a notice never blocks the action */ }
}

export function investmentDepsFor(db: () => Queryable, env: Env): InvestmentDeps {
  return {
    get repo() { return createPgInvestmentRepository(db()); },
    moduleState: () => readModuleState(env, db),
    postingSettings: () => loadPosting(db()),
    verification: userId => getBuyerVerification(db(), userId),
    countHit: async (key, windowMs) => countHitPg(db(), await hashToken(key), windowStart(new Date().toISOString(), windowMs)),
    contactFor: userId => contactPg(db(), userId),
    notify: (userId, template, subject, text) => notifyPg(db(), env, userId, template, subject, text),
    files: { storage: objectStorageFromEnv(env), scanner: malwareScannerFromEnv(env) },
    // The payments port fails closed until Westpac PayWay is connected (missing settings throw; the adapter throws on checkout).
    startUpfrontCheckout: p => createWestpacPayway(paywayConfigFromEnv(env)).createHostedCheckout(createInvoice(randomUUID(), p.ownerUserId, p.terms.upfrontFeeCents),
      `${(env["APP_URL"] ?? "").replace(/\/+$/, "")}/investments/${p.id}`),
    sha256: async b => createHash("sha256").update(b).digest("hex"),
    appUrl: (env["APP_URL"] ?? "").replace(/\/+$/, ""),
    appendAudit: e => appendAuditPg(db(), e),
    now: () => new Date().toISOString(),
    newId: () => randomUUID()
  };
}

/** Lazy: nothing touches the database until a call needs it, and the module state reads env first. */
export const getInvestmentDeps = (): InvestmentDeps => investmentDepsFor(getDb, process.env);
