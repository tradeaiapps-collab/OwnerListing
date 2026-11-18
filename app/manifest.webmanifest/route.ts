import { NextResponse } from "next/server";
import { buildManifest } from "../../src/domain/pwa";
import { getRequestTheme } from "../../src/server/request-theme";
import { brandFor } from "../../src/server/site-theme";
import { withApi } from "../../src/server/api/with-api";

/** Web app manifest (public site). The name follows the site brand set in Site appearance. */
async function handleGet() {
  const { settings } = await getRequestTheme();
  const brand = brandFor(settings);
  return new NextResponse(JSON.stringify(buildManifest({ name: brand.name, tagline: brand.tagline })), {
    headers: { "content-type": "application/manifest+json; charset=utf-8", "cache-control": "public, max-age=3600" }
  });
}

export const GET = withApi(handleGet);
