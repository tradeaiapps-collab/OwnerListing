import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { parseAuditQuery } from "../../../../src/domain/audit-query";
import { staffCan } from "../../../../src/domain/staff-access";
import { queryAuditPg } from "../../../../src/server/audit-read-db";
import { getDb, getStaff } from "../../../../src/server/context";
import { appendAuditPg } from "../../../../src/server/db";
import { withApi } from "../../../../src/server/api/with-api";

/** Staff audit log. Read-only (GET only): there is no way to change or delete an audit row through this API. */
async function handleGet(req: Request) {
  const staff = await getStaff(req);
  if (!staff) return NextResponse.json({ error: "Sign in as staff." }, { status: 401 });
  if (!staffCan(staff, "report.audit")) return NextResponse.json({ error: "Not allowed." }, { status: 403 });

  const parsed = parseAuditQuery(new URL(req.url).searchParams);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const db = getDb();
  const result = await queryAuditPg(db, parsed.query);
  const { cursor, ...filters } = parsed.query;
  // The view itself is audited: filters are validated tokens and dates (not free text), plus the row count.
  await appendAuditPg(db, {
    id: randomUUID(), occurredAt: new Date().toISOString(), actorType: "user", actorId: staff.id,
    aggregateType: "staff_session", aggregateId: staff.id, eventType: "staff.audit_viewed",
    correlationId: randomUUID(), payload: { role: staff.role, filters, returned: result.events.length, paged: cursor !== undefined }
  });
  return NextResponse.json(result);
}

export const GET = withApi(handleGet);
