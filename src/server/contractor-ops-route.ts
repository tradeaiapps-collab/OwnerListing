import { NextResponse } from "next/server";
import { csrfGuard } from "./csrf";
import { getActor, getDb } from "./context";
import { getJobContext, type JobContext } from "./contractor-ops-db";
import type { Queryable } from "./db";
import { unauthenticated } from "./http";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
export const error = (status: number, message: string, extra: Record<string, unknown> = {}) => json({ error: message, ...extra }, status);

export interface JobCall { db: Queryable; userId: string; job: JobContext; body: Record<string, unknown> }

/**
 * Common start of the job routes: CSRF on writes, the signed-in user, and the job only if that user is its owner or contractor.
 * Everyone else gets the same 404, so a job id cannot be probed. `body` is {} for a read or an unreadable body.
 */
export async function withJob(req: Request, params: Promise<{ id: string }>, write: boolean, fn: (c: JobCall) => Promise<NextResponse>): Promise<NextResponse> {
  if (write) { const blocked = csrfGuard(req); if (blocked) return blocked; }
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  if (!UUID.test(id)) return error(404, "Not found.");
  const db = getDb();
  const job = await getJobContext(db, id, actor.userId);
  if (!job) return error(404, "Not found.");
  const raw = write ? await req.json().catch(() => null) : {};
  const body = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return fn({ db, userId: actor.userId, job, body });
}
