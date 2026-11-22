import { NextResponse } from "next/server";
import { maskState, runAutoMask, saveMask } from "../../../../../../../src/domain/project-document-masking";
import { getDb, getMaskPorts } from "../../../../../../../src/server/context";
import { getInvestmentDeps } from "../../../../../../../src/server/investments-db";
import { investStaffGate, invFailure, notFound, ok, UUID, type Ctx } from "../../../../../../../src/server/investment-route";
import { createPgProjectDocStore } from "../../../../../../../src/server/project-documents-db";
import { fail, readJsonObject } from "../../../../../../../src/server/staff-route";
import { withApi } from "../../../../../../../src/server/api/with-api";

/** Current address masking of one investor-visible document (boxes, extra terms, revision). Opening it is audited. */
async function handleGet(req: Request, { params }: Ctx) {
  const deps = getInvestmentDeps();
  const staff = await investStaffGate(req, deps, "investment.review");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID.test(id)) return notFound();
  const r = await maskState(deps, createPgProjectDocStore(getDb()), getMaskPorts(), { staffId: staff.id }, id);
  return r.ok ? ok(r.value) : invFailure(r);
}

/**
 * { action: "auto", expectedRevision, terms? } runs Elena's auto-mask (manual boxes are kept).
 * { action: "save", expectedRevision, boxes, terms?, confirm?, allowUncovered? } saves the boxes as drawn and may confirm.
 */
async function handlePost(req: Request, { params }: Ctx) {
  const deps = getInvestmentDeps();
  const staff = await investStaffGate(req, deps, "investment.review");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID.test(id)) return notFound();
  const b = await readJsonObject(req);
  const expectedRevision = b?.["expectedRevision"];
  if (!Number.isInteger(expectedRevision) || (expectedRevision as number) < 0) return fail(400, "Reload the page and try again.");
  const terms = Array.isArray(b?.["terms"]) ? (b!["terms"] as unknown[]).filter((t): t is string => typeof t === "string") : undefined;
  const store = createPgProjectDocStore(getDb()), ports = getMaskPorts(), who = { staffId: staff.id };
  if (b?.["action"] === "auto") {
    const r = await runAutoMask(deps, store, ports, who, id, { expectedRevision: expectedRevision as number, ...(terms ? { terms } : {}) });
    return r.ok ? ok(r.value) : invFailure(r);
  }
  if (b?.["action"] === "save") {
    const r = await saveMask(deps, store, ports, who, id, {
      expectedRevision: expectedRevision as number, boxes: b["boxes"], ...(terms ? { terms } : {}), confirm: b["confirm"] === true, allowUncovered: b["allowUncovered"] === true
    });
    return r.ok ? ok(r.value) : invFailure(r);
  }
  return fail(400, "Choose auto or save.");
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
