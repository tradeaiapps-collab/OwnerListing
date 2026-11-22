import { NextResponse } from "next/server";
import { getVideoRepo, runQueueNow, videoIds } from "../../../../src/server/listing-video-db";
import { withApi } from "../../../../src/server/api/with-api";

/**
 * Hedra completion notice. The payload is NOT trusted: it only names a job, which is made due now, and the queue then asks Hedra itself
 * for the real status. So a forged notice can at most make us look at one of our own jobs a little early. The scheduler is the safety net.
 */
async function handlePost(req: Request) {
  if (Number(req.headers.get("content-length") ?? 0) > 64 * 1024) return NextResponse.json({ error: "Too large." }, { status: 413 });
  const body = (await req.json().catch(() => null)) as { job_id?: unknown } | null;
  const jobId = typeof body?.job_id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(body.job_id) ? body.job_id : null;
  if (!jobId) return NextResponse.json({ error: "Invalid notice." }, { status: 400 });
  await getVideoRepo().pullForward(jobId, videoIds.now());
  await runQueueNow(3).catch(() => undefined);
  return NextResponse.json({ ok: true });
}
export const POST = withApi(handlePost);
