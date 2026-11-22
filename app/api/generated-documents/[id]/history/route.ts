import { NextResponse } from "next/server";
import { getDb } from "../../../../../src/server/context";
import { generatedHistory } from "../../../../../src/server/transaction-db";
import { requireDocAccess } from "../../../../../src/server/transaction-http";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Every version of the document and every event on any of them (created, new version, opened, sign requested, signed, declined), oldest first. */
async function handleGet(req: Request, { params }: Ctx) {
  const a = await requireDocAccess(req, (await params).id);
  if (a instanceof NextResponse) return a;
  return NextResponse.json(await generatedHistory(getDb(), a.doc.id), { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
