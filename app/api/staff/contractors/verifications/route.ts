import { NextResponse } from "next/server";
import { todayUtc } from "../../../../../src/domain/contractor-trust";
import { getDb } from "../../../../../src/server/context";
import { prescreenVerificationsPg } from "../../../../../src/server/elena-prescreen-db";
import { certificateFlags } from "../../../../../src/domain/contractor-certificates";
import { currentCertificatesPg } from "../../../../../src/server/contractor-certificates-db";
import { listVerificationsPg } from "../../../../../src/server/contractor-trust-db";
import { staffGate } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";

/** Contractor details waiting for a check (?view=all adds decided ones, so expired insurance can be found). */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "licence.verify");
  if (staff instanceof NextResponse) return staff;
  const view = new URL(req.url).searchParams.get("view") === "all" ? "all" : "pending";
  const db = getDb();
  const rows = await listVerificationsPg(db, view, todayUtc());
  const screened = await prescreenVerificationsPg(db, rows, todayUtc()).catch(() => new Map());
  const certs = await currentCertificatesPg(db, rows.map(v => v.userId));
  return NextResponse.json({
    verifications: rows.map(v => {
      const files = certs.get(v.userId) ?? [];
      const of = (k: "insurance" | "licence") => files.find(c => c.kind === k);
      const flags = [...certificateFlags("insurance", v.insuranceExpiry, of("insurance")), ...certificateFlags("licence", v.licenceExpiry, of("licence"))];
      return { ...v, certificates: files, certificateFlags: flags, elena: screened.get(v.userId) ?? null };
    })
  }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
