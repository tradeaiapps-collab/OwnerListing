import { NextResponse } from "next/server";
import { documentsToMask } from "../../../../../src/domain/project-document-masking";
import { getDb } from "../../../../../src/server/context";
import { getInvestmentDeps } from "../../../../../src/server/investments-db";
import { investStaffGate, ok } from "../../../../../src/server/investment-route";
import { createPgProjectDocStore } from "../../../../../src/server/project-documents-db";
import { withApi } from "../../../../../src/server/api/with-api";

/** Review queue: investor-visible documents whose address masking is not confirmed yet (any project status). */
async function handleGet(req: Request) {
  const deps = getInvestmentDeps();
  const staff = await investStaffGate(req, deps, "investment.review");
  if (staff instanceof NextResponse) return staff;
  return ok({ items: await documentsToMask(deps, createPgProjectDocStore(getDb())) });
}

export const GET = withApi(handleGet);
