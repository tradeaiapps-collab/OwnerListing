import type { Source } from "../domain/elena-projects";
import type { AnswerMode, AnswerReviewRecord, ElenaProjectStore, QuestionRecord, ReplyRecord, UpdateRecord } from "../domain/elena-projects-service";
import type { Queryable } from "./db";

/** Constant SQL, parameters only. Questions and replies are insert-only; a published update cannot change (database trigger too). */
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

const toQuestion = (r: Record<string, unknown>): QuestionRecord => ({
  id: String(r["id"]), projectId: String(r["project_id"]), askerUserId: String(r["asker_user_id"]), question: String(r["question"]), answer: String(r["answer"]),
  outcome: r["outcome"] as QuestionRecord["outcome"], ...(r["reason"] ? { reason: String(r["reason"]) } : {}), sources: (r["sources"] ?? []) as Source[], createdAt: iso(r["created_at"]), needsApproval: r["needs_approval"] === true
});
const toUpdate = (r: Record<string, unknown>): UpdateRecord => ({
  id: String(r["id"]), projectId: String(r["project_id"]), title: String(r["title"]), body: String(r["body"]), status: r["status"] as UpdateRecord["status"],
  sourceDocIds: (r["source_doc_ids"] ?? []) as string[], createdBy: r["created_by"] as UpdateRecord["createdBy"], createdByUser: String(r["created_by_user"]),
  ...(r["approved_by"] ? { approvedBy: String(r["approved_by"]) } : {}), ...(r["approved_at"] ? { approvedAt: iso(r["approved_at"]) } : {}), createdAt: iso(r["created_at"])
});

const Q_COLS = "id, project_id, asker_user_id, question, answer, outcome, reason, sources, created_at, needs_approval";
const U_COLS = "id, project_id, title, body, status, source_doc_ids, created_by, created_by_user, approved_by, approved_at, created_at";

export function createPgElenaProjectStore(db: Queryable): ElenaProjectStore {
  return {
    async addQuestion(q) {
      await db.query(
        "INSERT INTO elena_project_question (id, project_id, asker_user_id, question, answer, outcome, reason, sources, created_at, needs_approval) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::jsonb, $9::timestamptz, $10::boolean)",
        [q.id, q.projectId, q.askerUserId, q.question, q.answer, q.outcome, q.reason ?? null, JSON.stringify(q.sources), q.createdAt, q.needsApproval === true]);
    },
    async questionsFor(projectId, askerId) {
      const rows = askerId
        ? (await db.query(`SELECT ${Q_COLS} FROM elena_project_question WHERE project_id = $1::uuid AND asker_user_id = $2::uuid ORDER BY created_at DESC, id LIMIT 200`, [projectId, askerId])).rows
        : (await db.query(`SELECT ${Q_COLS} FROM elena_project_question WHERE project_id = $1::uuid ORDER BY created_at DESC, id LIMIT 200`, [projectId])).rows;
      return rows.map(toQuestion);
    },
    async questionById(id) { const r = (await db.query(`SELECT ${Q_COLS} FROM elena_project_question WHERE id = $1::uuid`, [id])).rows[0]; return r ? toQuestion(r) : undefined; },
    async addReply(r: ReplyRecord) {
      await db.query("INSERT INTO elena_project_question_reply (id, question_id, owner_user_id, body, created_at) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz)", [r.id, r.questionId, r.ownerUserId, r.body, r.createdAt]);
    },
    async repliesFor(ids) {
      if (ids.length === 0) return [];
      return (await db.query("SELECT id, question_id, owner_user_id, body, created_at FROM elena_project_question_reply WHERE question_id = ANY($1::uuid[]) ORDER BY created_at, id", [ids as string[]]))
        .rows.map(r => ({ id: String(r["id"]), questionId: String(r["question_id"]), ownerUserId: String(r["owner_user_id"]), body: String(r["body"]), createdAt: iso(r["created_at"]) }));
    },
    async addUpdate(u) {
      await db.query(
        "INSERT INTO investment_project_update (id, project_id, title, body, status, source_doc_ids, created_by, created_by_user, created_at, updated_at) VALUES ($1::uuid, $2::uuid, $3, $4, 'draft', $5::uuid[], $6, $7::uuid, $8::timestamptz, $8::timestamptz)",
        [u.id, u.projectId, u.title, u.body, u.sourceDocIds, u.createdBy, u.createdByUser, u.createdAt]);
    },
    async updatesFor(projectId, includeDrafts) {
      const sql = includeDrafts
        ? `SELECT ${U_COLS} FROM investment_project_update WHERE project_id = $1::uuid ORDER BY created_at DESC, id LIMIT 100`
        : `SELECT ${U_COLS} FROM investment_project_update WHERE project_id = $1::uuid AND status = 'published' ORDER BY created_at DESC, id LIMIT 100`;
      return (await db.query(sql, [projectId])).rows.map(toUpdate);
    },
    async updateById(id) { const r = (await db.query(`SELECT ${U_COLS} FROM investment_project_update WHERE id = $1::uuid`, [id])).rows[0]; return r ? toUpdate(r) : undefined; },
    async saveDraft(id, title, body, at) {
      return (await db.query("UPDATE investment_project_update SET title = $2, body = $3, updated_at = $4::timestamptz WHERE id = $1::uuid AND status = 'draft' RETURNING id", [id, title, body, at])).rows.length === 1;
    },
    async publish(id, approverId, at) {
      return (await db.query("UPDATE investment_project_update SET status = 'published', approved_by = $2::uuid, approved_at = $3::timestamptz, updated_at = $3::timestamptz WHERE id = $1::uuid AND status = 'draft' RETURNING id", [id, approverId, at])).rows.length === 1;
    },
    async setFollow(projectId, userId, on, at) {
      if (on) await db.query("INSERT INTO investment_project_follow (project_id, user_id, created_at) VALUES ($1::uuid, $2::uuid, $3::timestamptz) ON CONFLICT DO NOTHING", [projectId, userId, at]);
      else await db.query("DELETE FROM investment_project_follow WHERE project_id = $1::uuid AND user_id = $2::uuid", [projectId, userId]);
    },
    async isFollowing(projectId, userId) { return (await db.query("SELECT 1 FROM investment_project_follow WHERE project_id = $1::uuid AND user_id = $2::uuid", [projectId, userId])).rows.length === 1; },
    async addReview(r: AnswerReviewRecord) {
      return (await db.query(
        "INSERT INTO elena_project_answer_review (question_id, owner_user_id, decision, body, created_at) VALUES ($1::uuid, $2::uuid, $3, $4, $5::timestamptz) ON CONFLICT (question_id) DO NOTHING RETURNING question_id",
        [r.questionId, r.ownerUserId, r.decision, r.body ?? null, r.createdAt])).rows.length === 1;
    },
    async reviewsFor(ids) {
      if (ids.length === 0) return [];
      return (await db.query("SELECT question_id, owner_user_id, decision, body, created_at FROM elena_project_answer_review WHERE question_id = ANY($1::uuid[])", [ids as string[]]))
        .rows.map(r => ({ questionId: String(r["question_id"]), ownerUserId: String(r["owner_user_id"]), decision: r["decision"] as AnswerReviewRecord["decision"], ...(r["body"] ? { body: String(r["body"]) } : {}), createdAt: iso(r["created_at"]) }));
    },
    async answerMode(projectId): Promise<AnswerMode> {
      const r = (await db.query("SELECT answer_mode FROM elena_project_answer_setting WHERE project_id = $1::uuid", [projectId])).rows[0];
      return r?.["answer_mode"] === "instant" ? "instant" : "approve_first";
    },
    async setAnswerMode(projectId, mode, userId, at) {
      await db.query(
        "INSERT INTO elena_project_answer_setting (project_id, answer_mode, updated_by, updated_at) VALUES ($1::uuid, $2, $3::uuid, $4::timestamptz) ON CONFLICT (project_id) DO UPDATE SET answer_mode = EXCLUDED.answer_mode, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at",
        [projectId, mode, userId, at]);
    },
    async followers(projectId, limit) { return (await db.query("SELECT user_id FROM investment_project_follow WHERE project_id = $1::uuid ORDER BY created_at LIMIT $2::int", [projectId, limit])).rows.map(r => String(r["user_id"])); }
  };
}
