import { randomUUID } from "node:crypto";
import { STARTER_TEMPLATES } from "../config/document-templates";
import { isTemplateCategory, parseStoredContent, type TemplateCategory, type TemplateContent } from "../domain/doc-templates";
import type { StaffActor } from "../domain/staff-access";
import { appendAuditPg, type Queryable } from "./db";

/**
 * Staff side of document templates. Insert-only: a save is a new version row, a publish is a new publish row, and the live
 * version is the one named by the latest publish. Publishing needs a different person from the one who wrote that version.
 * Constant SQL, bound parameters; content is validated before it reaches this layer.
 */
export interface TemplateVersionRow { version: number; createdBy: string; createdAt: string; changeNote: string; live: boolean }
export interface TemplateView {
  id: string; key: string; title: string; category: TemplateCategory; liveVersion: number | null; latestVersion: number;
  latest: TemplateContent; versions: TemplateVersionRow[];
}
export type TemplateOutcome<T = { version: number }> = ({ ok: true } & T) | { ok: false; code: "conflict" | "not_found" | "forbidden" | "invalid"; error: string };

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
const EMPTY: TemplateContent = { fields: [], clauses: [] };

async function inTx<T>(db: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  if (!db.transaction) throw new Error("Transactions are required.");
  return db.transaction(fn);
}
const audit = (db: Queryable, staff: StaffActor, id: string, eventType: string, payload: Record<string, unknown>) =>
  appendAuditPg(db, { id: randomUUID(), occurredAt: new Date().toISOString(), actorType: "user", actorId: staff.id, aggregateType: "doc_template", aggregateId: id, eventType, correlationId: randomUUID(), payload: { role: staff.role, ...payload } });

export async function loadTemplates(db: Queryable): Promise<TemplateView[]> {
  const ts = (await db.query("SELECT id, template_key, title, category FROM doc_template ORDER BY title")).rows;
  const vs = (await db.query(
    `SELECT v.template_id, v.version, v.content, v.change_note, v.created_at, u.display_name FROM doc_template_version v JOIN app_user u ON u.id = v.created_by ORDER BY v.template_id, v.version`
  )).rows;
  const live = (await db.query(
    `SELECT DISTINCT ON (p.template_id) p.template_id, v.version FROM doc_template_publish p JOIN doc_template_version v ON v.id = p.version_id ORDER BY p.template_id, p.id DESC`
  )).rows;
  return ts.map(t => {
    const mine = vs.filter(v => String(v["template_id"]) === String(t["id"]));
    const liveV = live.find(l => String(l["template_id"]) === String(t["id"]));
    const liveNo = liveV ? Number(liveV["version"]) : null;
    const last = mine[mine.length - 1];
    return {
      id: String(t["id"]), key: String(t["template_key"]), title: String(t["title"]), category: t["category"] as TemplateCategory,
      liveVersion: liveNo, latestVersion: last ? Number(last["version"]) : 0, latest: (last && parseStoredContent(last["content"])) || EMPTY,
      versions: mine.map(v => ({ version: Number(v["version"]), createdBy: String(v["display_name"]), createdAt: iso(v["created_at"]), changeNote: String(v["change_note"]), live: Number(v["version"]) === liveNo })).reverse()
    };
  });
}

/** Installs the starter templates that do not exist yet, each as draft version 1. Nothing goes live. */
export async function installStarters(db: Queryable, staff: StaffActor): Promise<{ installed: string[] }> {
  return inTx(db, async tx => {
    const installed: string[] = [];
    for (const s of STARTER_TEMPLATES) {
      const id = randomUUID();
      const ins = await tx.query(
        "INSERT INTO doc_template (id, template_key, title, category, created_by) VALUES ($1::uuid,$2,$3,$4,$5::uuid) ON CONFLICT (template_key) DO NOTHING RETURNING id", [id, s.key, s.title, s.category, staff.id]);
      if (ins.rows.length === 0) continue;
      await tx.query("INSERT INTO doc_template_version (template_id, version, content, change_note, created_by) VALUES ($1::uuid,1,$2::jsonb,$3,$4::uuid)", [id, JSON.stringify(s.content), "Starter wording, needs counsel review", staff.id]);
      await audit(tx, staff, id, "doc_template.created", { key: s.key, starter: true });
      installed.push(s.key);
    }
    return { installed };
  });
}

export async function createTemplate(db: Queryable, staff: StaffActor, input: { key: string; title: string; category: string; content: TemplateContent }): Promise<TemplateOutcome<{ id: string }>> {
  if (!/^[a-z0-9_]{3,40}$/.test(input.key)) return { ok: false, code: "invalid", error: "Key must be 3-40 lowercase letters, digits or underscores." };
  if (input.title.trim().length < 3 || input.title.length > 120) return { ok: false, code: "invalid", error: "Title must be 3-120 characters." };
  if (!isTemplateCategory(input.category)) return { ok: false, code: "invalid", error: "Choose a category." };
  return inTx(db, async tx => {
    const id = randomUUID();
    const ins = await tx.query("INSERT INTO doc_template (id, template_key, title, category, created_by) VALUES ($1::uuid,$2,$3,$4,$5::uuid) ON CONFLICT (template_key) DO NOTHING RETURNING id", [id, input.key, input.title.trim(), input.category, staff.id]);
    if (ins.rows.length === 0) return { ok: false as const, code: "conflict" as const, error: "A template with that key already exists." };
    await tx.query("INSERT INTO doc_template_version (template_id, version, content, change_note, created_by) VALUES ($1::uuid,1,$2::jsonb,'First draft',$3::uuid)", [id, JSON.stringify(input.content), staff.id]);
    await audit(tx, staff, id, "doc_template.created", { key: input.key });
    return { ok: true as const, id };
  });
}

/** New draft version. `baseVersion` is the latest version the editor loaded; another save in between gives a conflict. */
export async function saveVersion(db: Queryable, staff: StaffActor, templateId: string, baseVersion: number, content: TemplateContent, note: string): Promise<TemplateOutcome> {
  return inTx(db, async tx => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`doc_template:${templateId}`]);
    const t = (await tx.query("SELECT id FROM doc_template WHERE id = $1::uuid", [templateId])).rows[0];
    if (!t) return { ok: false as const, code: "not_found" as const, error: "Template not found." };
    const latest = Number((await tx.query("SELECT COALESCE(max(version), 0) AS v FROM doc_template_version WHERE template_id = $1::uuid", [templateId])).rows[0]?.["v"]);
    if (latest !== baseVersion) return { ok: false as const, code: "conflict" as const, error: `Someone saved version ${latest} since you opened this. Reload and try again.` };
    const version = latest + 1;
    await tx.query("INSERT INTO doc_template_version (template_id, version, content, change_note, created_by) VALUES ($1::uuid,$2,$3::jsonb,$4,$5::uuid)", [templateId, version, JSON.stringify(content), note.slice(0, 500), staff.id]);
    await audit(tx, staff, templateId, "doc_template.version_saved", { version });
    return { ok: true as const, version };
  });
}

/** Makes a version live. Never the version you wrote yourself. Documents already generated keep the version they were made from. */
export async function publishVersion(db: Queryable, staff: StaffActor, templateId: string, version: number): Promise<TemplateOutcome> {
  return inTx(db, async tx => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`doc_template:${templateId}`]);
    const v = (await tx.query("SELECT id, created_by, content FROM doc_template_version WHERE template_id = $1::uuid AND version = $2", [templateId, version])).rows[0];
    if (!v) return { ok: false as const, code: "not_found" as const, error: "Version not found." };
    if (!parseStoredContent(v["content"])) return { ok: false as const, code: "invalid" as const, error: "This version does not pass validation." };
    if (String(v["created_by"]) === staff.id) return { ok: false as const, code: "forbidden" as const, error: "A different person must publish a version you wrote." };
    const cur = (await tx.query("SELECT version_id FROM doc_template_publish WHERE template_id = $1::uuid ORDER BY id DESC LIMIT 1", [templateId])).rows[0];
    if (cur && String(cur["version_id"]) === String(v["id"])) return { ok: false as const, code: "conflict" as const, error: "That version is already live." };
    await tx.query("INSERT INTO doc_template_publish (template_id, version_id, published_by) VALUES ($1::uuid,$2::uuid,$3::uuid)", [templateId, v["id"], staff.id]);
    await audit(tx, staff, templateId, "doc_template.published", { version });
    return { ok: true as const, version };
  });
}
