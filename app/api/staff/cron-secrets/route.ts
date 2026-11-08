import { NextResponse } from "next/server";
import { allCronStatus, isCronJob, rotateCronSecret, setCronEnabled } from "../../../../src/server/cron-secret-db";
import { getDb } from "../../../../src/server/context";
import { fail, readJsonObject, staffAudit, staffGate } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

const noStore = { "cache-control": "no-store" };

/** Status of each scheduled job's secret: where it comes from, on or off, last four characters, last call. The secret itself is never returned here. */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "config.edit");
  if (staff instanceof NextResponse) return staff;
  return NextResponse.json({ jobs: await allCronStatus(getDb()) }, { headers: noStore });
}

/** Body { job, action: "rotate" | "enable" | "disable" }. Rotate returns the new secret once; only its hash is kept. Every change is audited. */
async function handlePost(req: Request) {
  const staff = await staffGate(req, "config.edit");
  if (staff instanceof NextResponse) return staff;
  const body = await readJsonObject(req);
  const job = body?.["job"], action = body?.["action"];
  if (!isCronJob(job)) return fail(400, "Unknown job.");
  if (action !== "rotate" && action !== "enable" && action !== "disable") return fail(400, "Unknown action.");
  const db = getDb();
  let secret: string | undefined;
  if (action === "rotate") secret = await rotateCronSecret(db, job, staff.id);
  else await setCronEnabled(db, job, staff.id, action === "enable");
  await staffAudit(staff, "cron_secret", job, `staff.cron_secret.${action === "rotate" ? "rotated" : action === "enable" ? "enabled" : "disabled"}`, {});
  const jobs = await allCronStatus(db);
  return NextResponse.json({ jobs, ...(secret ? { job, secret } : {}) }, { headers: noStore });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
