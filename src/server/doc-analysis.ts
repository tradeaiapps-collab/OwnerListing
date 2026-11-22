import type { AnalystDeps } from "../domain/doc-analysis-service";
import { getDb, getDeps, getUploadPorts } from "./context";
import { createPgAnalysisStore } from "./doc-analysis-db";
import { extractText } from "./doc-extract";
import { createOcrPort } from "./ocr";
import { createPgDocumentStore } from "./documents-db";
import { notifyUser } from "./notifier";

/** Wires the document analyst to the real database, storage and notifier. */
export function getAnalystDeps(): AnalystDeps {
  const db = getDb();
  return {
    deps: getDeps(),
    docs: createPgDocumentStore(db),
    store: createPgAnalysisStore(db),
    storage: getUploadPorts().storage,
    extract: async (bytes, contentType) => {
      const r = await extractText(bytes, contentType, createOcrPort());
      return r.ok ? { ok: true, text: r.text } : r;
    },
    notify: async (userId, params) => { await notifyUser(db, userId, "document_analysed", params); }
  };
}
