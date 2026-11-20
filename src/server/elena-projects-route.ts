import { NextResponse } from "next/server";
import type { DocTextPort, ElenaPorts } from "../domain/elena-projects-service";
import { getDb } from "./context";
import { createPgElenaProjectStore } from "./elena-projects-db";
import { investGate, invFailure, notFound, UUID } from "./investment-route";
import { getInvestmentDeps } from "./investments-db";
import { createPgProjectDocStore } from "./project-documents-db";
import { objectStorageFromEnv } from "../adapters/object-storage";

const MAX_BODY = 16 * 1024;

/** Reads PDFs with pdf.js (loaded on first use; heavy native code). Images and scans have no text, so Elena cannot quote them. */
const text: DocTextPort = {
  async pages(bytes, mime) {
    if (mime !== "application/pdf") return [];
    return (await import("./pdf-pages")).extractPdfPages(bytes);
  }
};

export const elenaWiring = () => ({
  deps: getInvestmentDeps(), store: createPgElenaProjectStore(getDb()), docs: createPgProjectDocStore(getDb()),
  ports: { storage: objectStorageFromEnv(process.env), text } satisfies ElenaPorts
});

/** JSON body of at most 16 KB, or null. */
export async function smallJson(req: Request): Promise<unknown> {
  const raw = await req.text().catch(() => "");
  if (raw.length > MAX_BODY) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** Module live, CSRF, signed in, and every path id a UUID. Returns what a handler needs or the response to send. */
export async function elenaGate(req: Request, ids: readonly string[]) {
  const w = elenaWiring();
  const actor = await investGate(req, w.deps);
  if (actor instanceof NextResponse) return actor;
  if (!ids.every(i => UUID.test(i))) return notFound();
  return { ...w, actor };
}
export { invFailure };
