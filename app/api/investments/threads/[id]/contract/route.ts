import { NextResponse } from "next/server";
import { MAX_CONTRACT_BYTES, submitContract } from "../../../../../../src/domain/investment-service";
import { getInvestmentDeps } from "../../../../../../src/server/investments-db";
import { investGate, invFailure, notFound, ok, UUID, type Ctx } from "../../../../../../src/server/investment-route";

/** Reads the body but stops past `max` bytes (a missing or false Content-Length cannot make the server buffer more). null = too big. */
async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) { await reader.cancel().catch(() => undefined); return null; }
      parts.push(value);
    }
  } catch { return new Uint8Array(0); }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** The investor uploads the signed agreement: the raw PDF bytes as the body (Content-Type application/pdf). Only POST: files are never deleted. */
export async function POST(req: Request, { params }: Ctx) {
  const deps = getInvestmentDeps();
  const actor = await investGate(req, deps, { json: false });
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  if (!UUID.test(id)) return notFound();
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_CONTRACT_BYTES) return NextResponse.json({ error: "Upload a PDF of up to 10 MB." }, { status: 413 });
  const bytes = await readCapped(req, MAX_CONTRACT_BYTES);
  if (!bytes) return NextResponse.json({ error: "Upload a PDF of up to 10 MB." }, { status: 413 });
  const r = await submitContract(deps, actor, id, bytes);
  return r.ok ? ok({ contractStatus: r.value }, 201) : invFailure(r);
}
