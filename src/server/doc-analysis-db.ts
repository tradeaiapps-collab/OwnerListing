import type { Analysis, DocClass, Rating } from "../domain/doc-analyst";
import type { AnalysisStore, StoredAnalysis } from "../domain/doc-analysis-service";
import type { Queryable } from "./db";


const toStored = (r: Record<string, unknown>): StoredAnalysis => ({
  id: String(r["id"]), documentId: String(r["document_id"]), listingId: String(r["listing_id"]),
  createdAt: new Date(String(r["created_at"])).toISOString(), analysis: r["analysis"] as Analysis
});

const SELECT = "SELECT id, document_id, listing_id, created_at, analysis FROM document_analysis";

export async function latestAnalysisPg(db: Queryable, documentId: string, engine: string): Promise<StoredAnalysis | undefined> {
  const res = await db.query(`${SELECT} WHERE document_id = $1 AND engine = $2 ORDER BY created_at DESC LIMIT 1`, [documentId, engine]);
  return res.rows[0] ? toStored(res.rows[0]) : undefined;
}

export async function analysisByIdPg(db: Queryable, id: string): Promise<StoredAnalysis | undefined> {
  const res = await db.query(`${SELECT} WHERE id = $1`, [id]);
  return res.rows[0] ? toStored(res.rows[0]) : undefined;
}

export async function insertAnalysisPg(
  db: Queryable, a: { id: string; documentId: string; listingId: string; requestedBy: string; textSha256: string; analysis: Analysis }
): Promise<void> {
  await db.query(
    `INSERT INTO document_analysis (id, document_id, listing_id, requested_by, engine, doc_class, rating, text_sha256, analysis)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [a.id, a.documentId, a.listingId, a.requestedBy, a.analysis.engine, a.analysis.docClass satisfies DocClass, a.analysis.rating satisfies Rating, a.textSha256, JSON.stringify(a.analysis)]
  );
}

/** Readings this user started since `sinceIso`. Used for a per-hour limit; the work is CPU only, so a read-then-insert race is acceptable. */
export async function countRecentAnalysesPg(db: Queryable, userId: string, sinceIso: string): Promise<number> {
  const res = await db.query("SELECT count(*) AS n FROM document_analysis WHERE requested_by = $1 AND created_at >= $2::timestamptz", [userId, sinceIso]);
  return Number(res.rows[0]?.["n"] ?? 0);
}

export async function insertSharesPg(db: Queryable, analysisId: string, sharedBy: string, userIds: readonly string[]): Promise<string[]> {
  const added: string[] = [];
  for (const u of userIds) {
    const res = await db.query("INSERT INTO document_analysis_share (analysis_id, user_id, shared_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING user_id", [analysisId, u, sharedBy]);
    if (res.rows[0]) added.push(u);
  }
  return added;
}

export const createPgAnalysisStore = (db: Queryable): AnalysisStore => ({
  latest: (documentId, engine) => latestAnalysisPg(db, documentId, engine),
  byId: id => analysisByIdPg(db, id),
  insert: a => insertAnalysisPg(db, a),
  countRecent: (userId, sinceIso) => countRecentAnalysesPg(db, userId, sinceIso),
  addShares: (analysisId, sharedBy, userIds) => insertSharesPg(db, analysisId, sharedBy, userIds)
});
