import { NextResponse } from "next/server";
import { parseOptionalAbn } from "../../../../../../src/domain/abn";
import { getDb } from "../../../../../../src/server/context";
import { fail, readJsonObject, staffAudit, staffGate, UUID_RE } from "../../../../../../src/server/staff-route";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Staff record (or clear) a law firm's ABN while reviewing its trust account. Body: { "abn": "51 824 753 556" | "" }.
 * The checksum is enforced here and again by the database; digits only are stored. Same permission as the trust account queue.
 */
async function handlePut(req: Request, { params }: Ctx) {
  const staff = await staffGate(req, "trust_account.approve");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID_RE.test(id)) return fail(404, "Firm not found.");
  const body = await readJsonObject(req);
  if (body === null || Object.keys(body).some(k => k !== "abn")) return fail(400, 'Send { "abn": "..." }.');
  const parsed = parseOptionalAbn(body["abn"]);
  if (!parsed.ok) return fail(400, parsed.error);
  const r = await getDb().query(`UPDATE law_firm SET abn = $2 WHERE id = $1 RETURNING id`, [id, parsed.abn]);
  if (r.rows.length !== 1) return fail(404, "Firm not found.");
  await staffAudit(staff, "law_firm", id, "staff.law_firm_abn_set", { cleared: parsed.abn === null });
  return NextResponse.json({ ok: true, abn: parsed.abn });
}

export const PUT = withApi(handlePut);
