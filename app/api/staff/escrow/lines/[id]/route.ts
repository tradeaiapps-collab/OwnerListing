import { NextResponse } from "next/server";
import { getDb } from "../../../../../../src/server/context";
import { matchLine, receiptFromLine } from "../../../../../../src/server/deposit-escrow-db";
import { fail, readJsonObject, staffGate, UUID_RE } from "../../../../../../src/server/staff-route";
import { withApi } from "../../../../../../src/server/api/with-api";

/**
 * Reconciles one bank statement line. A person always confirms; nothing is matched automatically.
 * Body: { action: "match", movementId } (a ledger entry recorded earlier) | { action: "receipt", holdingId } (record the deposit from this line).
 */
async function handlePost(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const staff = await staffGate(req, "escrow.manage");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID_RE.test(id)) return fail(404, "Statement line not found.");
  const body = await readJsonObject(req);
  if (!body) return fail(400, "Send the action.");
  const target = body["action"] === "match" ? body["movementId"] : body["action"] === "receipt" ? body["holdingId"] : null;
  if (target === null) return fail(400, "Unknown action.");
  if (typeof target !== "string" || !UUID_RE.test(target)) return fail(400, "Choose what this line is.");
  const db = getDb();
  const r = body["action"] === "match" ? await matchLine(db, staff, id, target) : await receiptFromLine(db, staff, id, target);
  return r.ok ? NextResponse.json(r.value) : fail(r.status, r.error);
}

export const POST = withApi(handlePost);
