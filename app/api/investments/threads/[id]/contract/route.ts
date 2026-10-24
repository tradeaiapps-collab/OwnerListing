import { NextResponse } from "next/server";
import { MAX_CONTRACT_BYTES, submitContract } from "../../../../../../src/domain/investment-service";
import { getInvestmentDeps } from "../../../../../../src/server/investments-db";
import { investGate, invFailure, notFound, ok, UUID, type Ctx } from "../../../../../../src/server/investment-route";

/** The investor uploads the signed agreement: the raw PDF bytes as the body (Content-Type application/pdf). Only POST: files are never deleted. */
export async function POST(req: Request, { params }: Ctx) {
  const deps = getInvestmentDeps();
  const actor = await investGate(req, deps, { json: false });
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  if (!UUID.test(id)) return notFound();
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_CONTRACT_BYTES) return NextResponse.json({ error: "Upload a PDF of up to 10 MB." }, { status: 413 });
  const bytes = new Uint8Array(await req.arrayBuffer().catch(() => new ArrayBuffer(0)));
  const r = await submitContract(deps, actor, id, bytes);
  return r.ok ? ok({ contractStatus: r.value }, 201) : invFailure(r);
}
