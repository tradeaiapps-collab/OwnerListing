import { createDocusignProvider, docusignConfigFromEnv } from "../adapters/docusign";
import { objectStorageFromEnv } from "../adapters/object-storage";
import type { EsignDeps } from "../domain/esign-service";
import { signingIds } from "./signing-db";
import { getSigningRepo } from "./signing-db";

/**
 * Which provider signs new documents. SIGNING_PROVIDER=docusign sends new documents through DocuSign; anything else (the default) keeps
 * the built-in click-to-sign. There is no silent switch: with docusign selected but not fully configured, new documents are refused
 * rather than quietly signed by the weaker method. Documents already out for signature keep the provider they started with.
 */
export type SigningMode = "builtin" | "docusign";
export const signingMode = (env: NodeJS.ProcessEnv = process.env): SigningMode => ((env["SIGNING_PROVIDER"] ?? "").trim().toLowerCase() === "docusign" ? "docusign" : "builtin");

export const appUrl = (env: NodeJS.ProcessEnv = process.env) => (env["APP_URL"] ?? "").replace(/\/+$/, "");

let override: EsignDeps | null | undefined;
/** Tests inject a fake here; production leaves it undefined. */
export const setEsignOverride = (d: EsignDeps | null | undefined) => { override = d; };

/** Everything the DocuSign flow needs, or undefined when DocuSign is not configured. */
export function getEsignDeps(env: NodeJS.ProcessEnv = process.env): EsignDeps | undefined {
  if (override !== undefined) return override ?? undefined;
  const cfg = docusignConfigFromEnv(env);
  if (!cfg || !appUrl(env)) return undefined;
  return { repo: getSigningRepo(), esign: createDocusignProvider(cfg), storage: objectStorageFromEnv(env), ids: signingIds, appUrl: appUrl(env) };
}
