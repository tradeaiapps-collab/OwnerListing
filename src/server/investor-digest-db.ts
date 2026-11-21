import { buildDigest, DIGEST_INTERVAL_MS, windowStart, type DigestAnswer, type DigestUpdate } from "../domain/investor-digest";
import type { Queryable } from "./db";
import { defaultNotify, type Notify } from "./elena-enquiries-db";
import { readModuleState } from "./investments-db";

// Constant SQL, bound parameters only. Read-only except the per-investor setting row.
type Env = Readonly<Record<string, string | undefined>>;
const text = (v: unknown) => String(v);
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

export async function getInvestorDigest(db: Queryable, userId: string): Promise<{ enabled: boolean; lastSentAt: string | null }> {
  const r = (await db.query("SELECT enabled, last_sent_at FROM investor_digest_setting WHERE user_id = $1::uuid", [userId])).rows[0];
  return { enabled: r ? r["enabled"] === true : true, lastSentAt: r?.["last_sent_at"] ? iso(r["last_sent_at"]) : null };
}
export async function setInvestorDigest(db: Queryable, userId: string, enabled: boolean): Promise<void> {
  await db.query("INSERT INTO investor_digest_setting (user_id, enabled) VALUES ($1::uuid, $2::boolean) ON CONFLICT (user_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()", [userId, enabled]);
}

/** Investors with something to follow (a followed project, an interest, or a question asked) whose weekly digest is due and who have not opted out. */
export const DIGEST_DUE_SQL =
  "SELECT u.id AS user_id, s.last_sent_at FROM app_user u LEFT JOIN investor_digest_setting s ON s.user_id = u.id " +
  "WHERE u.status = 'active' AND COALESCE(s.enabled, true) AND (s.last_sent_at IS NULL OR s.last_sent_at <= $1::timestamptz - make_interval(secs => $2::int)) " +
  "AND (EXISTS (SELECT 1 FROM investment_project_follow f WHERE f.user_id = u.id) OR EXISTS (SELECT 1 FROM investment_interest i WHERE i.investor_user_id = u.id) " +
  "OR EXISTS (SELECT 1 FROM elena_project_question q WHERE q.asker_user_id = u.id)) ORDER BY s.last_sent_at NULLS FIRST, u.id LIMIT 200";

/** Same rule as the investor pages: approved, not the investor's own, and allowed by the project's visibility for the investor's latest declared category. */
const MAY_SEE =
  "p.status = 'approved' AND p.owner_user_id <> $1::uuid AND EXISTS (SELECT 1 FROM investor_declaration d WHERE d.user_id = $1::uuid AND d.declared_at = " +
  "(SELECT max(d2.declared_at) FROM investor_declaration d2 WHERE d2.user_id = $1::uuid) AND (p.visible_to = 'all_verified' OR d.category IN ('wholesale','sophisticated')))";

/** Owner-approved updates published in the window, on projects the investor follows or has registered interest in. */
export const UPDATES_SQL =
  "SELECT p.id AS project_id, p.title AS project_title, up.title, up.body, up.approved_at AS at FROM investment_project_update up JOIN investment_project p ON p.id = up.project_id " +
  `WHERE up.status = 'published' AND up.approved_at > $2::timestamptz AND up.approved_at <= $3::timestamptz AND ${MAY_SEE} ` +
  "AND (EXISTS (SELECT 1 FROM investment_project_follow f WHERE f.project_id = p.id AND f.user_id = $1::uuid) OR EXISTS (SELECT 1 FROM investment_interest i WHERE i.project_id = p.id AND i.investor_user_id = $1::uuid)) " +
  "ORDER BY up.approved_at DESC, up.id LIMIT 60";
/** The investor's OWN questions that Elena answered in the window. Never other investors' questions. Source documents are not read, so no document title can leak. */
export const ELENA_ANSWERS_SQL =
  "SELECT p.id AS project_id, p.title AS project_title, q.question, q.answer, q.created_at AS at FROM elena_project_question q JOIN investment_project p ON p.id = q.project_id " +
  `WHERE q.asker_user_id = $1::uuid AND q.outcome = 'answered' AND q.created_at > $2::timestamptz AND q.created_at <= $3::timestamptz AND ${MAY_SEE} ORDER BY q.created_at DESC, q.id LIMIT 60`;
/** Owner replies to the investor's own questions in the window. */
export const OWNER_REPLIES_SQL =
  "SELECT p.id AS project_id, p.title AS project_title, q.question, r.body AS answer, r.created_at AS at FROM elena_project_question_reply r JOIN elena_project_question q ON q.id = r.question_id " +
  `JOIN investment_project p ON p.id = q.project_id WHERE q.asker_user_id = $1::uuid AND r.created_at > $2::timestamptz AND r.created_at <= $3::timestamptz AND ${MAY_SEE} ORDER BY r.created_at DESC, r.id LIMIT 60`;

export async function digestContent(db: Queryable, userId: string, from: string, to: string): Promise<{ updates: DigestUpdate[]; answers: DigestAnswer[] }> {
  const [u, e, o] = await Promise.all([db.query(UPDATES_SQL, [userId, from, to]), db.query(ELENA_ANSWERS_SQL, [userId, from, to]), db.query(OWNER_REPLIES_SQL, [userId, from, to])]);
  const updates = u.rows.map(r => ({ projectId: text(r["project_id"]), projectTitle: text(r["project_title"]), title: text(r["title"]), body: text(r["body"]), at: iso(r["at"]) }));
  const answers: DigestAnswer[] = [
    ...e.rows.map(r => ({ projectId: text(r["project_id"]), projectTitle: text(r["project_title"]), question: text(r["question"]), answer: text(r["answer"]), by: "elena" as const, at: iso(r["at"]) })),
    ...o.rows.map(r => ({ projectId: text(r["project_id"]), projectTitle: text(r["project_title"]), question: text(r["question"]), answer: text(r["answer"]), by: "owner" as const, at: iso(r["at"]) }))
  ].sort((a, b) => b.at.localeCompare(a.at));
  return { updates, answers };
}

/**
 * One tick: sends each due investor at most one digest a week, only when something new happened. Claimed before sending (compare-and-set on last_sent_at),
 * so a repeat or overlapping run never double-sends; a crash can lose a digest, never double it. Does nothing while the investor module is off.
 */
export async function runInvestorDigests(db: Queryable, now: string, env: Env = process.env, notify: Notify = defaultNotify(db)): Promise<{ sent: number; skipped: number }> {
  if (!(await readModuleState(env, () => db)).live) return { sent: 0, skipped: 0 };
  let sent = 0, skipped = 0;
  for (const r of (await db.query(DIGEST_DUE_SQL, [now, Math.floor(DIGEST_INTERVAL_MS / 1000)])).rows) {
    const userId = text(r["user_id"]), last = r["last_sent_at"] ? iso(r["last_sent_at"]) : null;
    const claim = await db.query(
      "INSERT INTO investor_digest_setting (user_id, enabled, last_sent_at) VALUES ($1::uuid, true, $2::timestamptz) ON CONFLICT (user_id) DO UPDATE SET last_sent_at = EXCLUDED.last_sent_at, updated_at = now() " +
      "WHERE investor_digest_setting.enabled AND investor_digest_setting.last_sent_at IS NOT DISTINCT FROM $3::timestamptz RETURNING user_id", [userId, now, last]);
    if (!claim.rows.length) continue;
    const c = await digestContent(db, userId, windowStart(last, now), now);
    const d = buildDigest(c.updates, c.answers);
    if (!d) { skipped++; continue; }
    await notify(userId, "investor_digest", { title: d.title, text: d.text, link: "/investments" });
    sent++;
  }
  return { sent, skipped };
}
