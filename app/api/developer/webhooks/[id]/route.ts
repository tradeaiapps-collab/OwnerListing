import { NextResponse } from "next/server";
import { withPrincipal } from "../../../../../src/server/api/principal";
import { getDb } from "../../../../../src/server/context";
import { deleteEndpoint } from "../../../../../src/server/public-api-db";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

async function handleDelete(req: Request, { params }: Ctx) {
  const { id } = await params;
  return withPrincipal(req, "webhooks.manage", async userId =>
    (await deleteEndpoint(getDb(), userId, id)) ? NextResponse.json({ deleted: true }) : NextResponse.json({ error: "Endpoint not found.", code: "not_found" }, { status: 404 }));
}

export const DELETE = withApi(handleDelete);
