import { NextResponse } from "next/server";
import { buildOpenApi } from "../../../src/domain/openapi";
import { withApi } from "../../../src/server/api/with-api";

/** The OpenAPI 3.1 description of the public API. Public, no data. */
function handleGet() {
  return NextResponse.json(buildOpenApi(process.env["APP_URL"]?.replace(/\/$/, "") ?? ""), { headers: { "cache-control": "public, max-age=300" } });
}

export const GET = withApi(handleGet);
