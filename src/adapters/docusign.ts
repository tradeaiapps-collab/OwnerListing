import { createSign, randomUUID } from "node:crypto";
import { recipientsFrom, type EnvelopeState, type EnvelopeUpdate } from "../domain/docusign";

/**
 * DocuSign eSignature REST client (no SDK). Authentication is the JWT grant: the platform signs a short assertion with an RSA key and
 * trades it for an access token; the integration user must grant consent once. See docs/DOCUSIGN.md for setup.
 * Every call has a timeout, hosts are limited to DocuSign's own domains, and nothing here logs bodies, tokens or keys.
 */
export interface EsignProvider {
  readonly name: "docusign";
  /** Creates and sends the envelope. Returns its id. */
  createEnvelope(definition: Record<string, unknown>): Promise<{ envelopeId: string }>;
  /** One-time URL that opens DocuSign's signing page for one embedded signer, then returns them to returnUrl. */
  recipientView(envelopeId: string, r: { clientUserId: string; name: string; email: string; returnUrl: string }): Promise<string>;
  voidEnvelope(envelopeId: string, reason: string): Promise<void>;
  /** Current envelope and recipient state, for the manual refresh when a webhook was missed. */
  envelopeStatus(envelopeId: string): Promise<EnvelopeUpdate>;
  /** "combined" is every document with the certificate merged in; "certificate" is the certificate of completion alone. */
  download(envelopeId: string, which: "combined" | "certificate"): Promise<Uint8Array>;
}

const HOST_OK = /^(?:[a-z0-9-]+\.)+docusign\.(?:net|com)$/i;
const TIMEOUT_MS = 20_000;
const MAX_PDF_BYTES = 40 * 1024 * 1024;

export interface DocusignConfig { integrationKey: string; userId: string; accountId: string; privateKey: string; basePath: string; oauthHost: string }

/** Reads DOCUSIGN_* settings. Returns undefined unless every required key is present and well formed (provider-check says which is wrong). */
export function docusignConfigFromEnv(env: NodeJS.ProcessEnv): DocusignConfig | undefined {
  const g = (k: string) => (env[k] ?? "").trim();
  const privateKey = g("DOCUSIGN_PRIVATE_KEY").replace(/\\n/g, "\n");
  const cfg = { integrationKey: g("DOCUSIGN_INTEGRATION_KEY"), userId: g("DOCUSIGN_USER_ID"), accountId: g("DOCUSIGN_ACCOUNT_ID"), privateKey,
    basePath: (g("DOCUSIGN_BASE_PATH") || "https://demo.docusign.net/restapi").replace(/\/+$/, ""), oauthHost: g("DOCUSIGN_OAUTH_HOST") || "account-d.docusign.com" };
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  try {
    if (!UUID.test(cfg.integrationKey) || !UUID.test(cfg.userId) || !UUID.test(cfg.accountId)) return undefined;
    if (!/^-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+-----END (?:RSA )?PRIVATE KEY-----\s*$/.test(privateKey)) return undefined;
    const base = new URL(cfg.basePath);
    if (base.protocol !== "https:" || !HOST_OK.test(base.hostname)) return undefined;
    if (!HOST_OK.test(cfg.oauthHost)) return undefined;
  } catch { return undefined; }
  return cfg;
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function jwtAssertion(cfg: DocusignConfig, nowSeconds: number): string {
  const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64u(JSON.stringify({ iss: cfg.integrationKey, sub: cfg.userId, aud: cfg.oauthHost, iat: nowSeconds, exp: nowSeconds + 3600, scope: "signature impersonation" }));
  const sig = createSign("RSA-SHA256").update(`${head}.${claims}`).sign(cfg.privateKey);
  return `${head}.${claims}.${b64u(sig)}`;
}

export function createDocusignProvider(cfg: DocusignConfig, fetchImpl: typeof fetch = fetch, now: () => number = () => Date.now()): EsignProvider {
  let token: { value: string; expiresAt: number } | undefined;
  const call = async (url: string, init: RequestInit): Promise<Response> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try { return await fetchImpl(url, { ...init, signal: ctrl.signal, redirect: "error" }); } finally { clearTimeout(timer); }
  };
  async function accessToken(): Promise<string> {
    if (token && token.expiresAt - 300_000 > now()) return token.value;
    const res = await call(`https://${cfg.oauthHost}/oauth/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwtAssertion(cfg, Math.floor(now() / 1000)) })
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !body.access_token) throw new Error(`DocuSign sign-in failed (${res.status}${body.error ? ` ${body.error}` : ""}). If this is consent_required, grant consent once.`);
    token = { value: body.access_token, expiresAt: now() + (body.expires_in ?? 3600) * 1000 };
    return token.value;
  }
  const api = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const res = await call(`${cfg.basePath}/v2.1/accounts/${cfg.accountId}${path}`, { ...init, headers: { authorization: `Bearer ${await accessToken()}`, accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
    if (res.status === 401) token = undefined;
    return res;
  };
  const failed = async (what: string, res: Response): Promise<never> => {
    const body = (await res.json().catch(() => ({}))) as { errorCode?: string };
    throw new Error(`DocuSign ${what} failed (${res.status}${body.errorCode ? ` ${body.errorCode}` : ""}).`);
  };
  return {
    name: "docusign",
    async createEnvelope(definition) {
      const res = await api("/envelopes", { method: "POST", body: JSON.stringify(definition) });
      if (!res.ok) return failed("create envelope", res);
      const id = ((await res.json()) as { envelopeId?: string }).envelopeId;
      if (!id) throw new Error("DocuSign did not return an envelope id.");
      return { envelopeId: id };
    },
    async recipientView(envelopeId, r) {
      const res = await api(`/envelopes/${encodeURIComponent(envelopeId)}/views/recipient`, {
        method: "POST", body: JSON.stringify({ returnUrl: r.returnUrl, authenticationMethod: "none", email: r.email, userName: r.name, clientUserId: r.clientUserId })
      });
      if (!res.ok) return failed("signing link", res);
      const url = ((await res.json()) as { url?: string }).url;
      if (!url || !HOST_OK.test(new URL(url).hostname)) throw new Error("DocuSign returned an unexpected signing link.");
      return url;
    },
    async voidEnvelope(envelopeId, reason) {
      const res = await api(`/envelopes/${encodeURIComponent(envelopeId)}`, { method: "PUT", body: JSON.stringify({ status: "voided", voidedReason: reason.slice(0, 200) }) });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { errorCode?: string };
        if (body.errorCode === "ENVELOPE_INVALID_STATUS") return; // already closed on their side
        throw new Error(`DocuSign void failed (${res.status}${body.errorCode ? ` ${body.errorCode}` : ""}).`);
      }
    },
    async envelopeStatus(envelopeId) {
      const res = await api(`/envelopes/${encodeURIComponent(envelopeId)}?include=recipients`);
      if (!res.ok) return failed("status check", res);
      const body = (await res.json()) as { status?: string; recipients?: unknown };
      const s = body.status?.toLowerCase();
      const envelope = s === "sent" || s === "delivered" || s === "completed" || s === "declined" || s === "voided" ? (s as EnvelopeState) : undefined;
      return { envelopeId, ...(envelope ? { envelope } : {}), recipients: recipientsFrom({ recipients: body.recipients }) };
    },
    async download(envelopeId, which) {
      const res = await api(`/envelopes/${encodeURIComponent(envelopeId)}/documents/${which}`, { headers: { accept: "application/pdf" } });
      if (!res.ok) return failed("download", res);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length < 100 || buf.length > MAX_PDF_BYTES || String.fromCharCode(...buf.slice(0, 4)) !== "%PDF") throw new Error("DocuSign returned something that is not a PDF.");
      return buf;
    }
  };
}

/** In-memory stand-in for tests and local development. Records calls; tests set statuses and PDFs. */
export interface FakeEsign extends EsignProvider {
  envelopes: Map<string, { definition: Record<string, unknown>; status: EnvelopeState; voided?: string }>;
  views: { envelopeId: string; clientUserId: string; returnUrl: string }[];
  failNext(op: "createEnvelope" | "download" | "voidEnvelope" | "recipientView"): void;
}
const FAKE_PDF = (label: string) => new TextEncoder().encode(`%PDF-1.4\n% ${label} ${"x".repeat(100)}\n%%EOF\n`);
export function createFakeEsign(): FakeEsign {
  const envelopes: FakeEsign["envelopes"] = new Map();
  const views: FakeEsign["views"] = [];
  const failing = new Set<string>();
  const check = (op: string) => { if (failing.delete(op)) throw new Error(`fake ${op} failure`); };
  return {
    name: "docusign", envelopes, views,
    failNext: op => { failing.add(op); },
    async createEnvelope(definition) { check("createEnvelope"); const envelopeId = `fake-${randomUUID()}`; envelopes.set(envelopeId, { definition, status: "sent" }); return { envelopeId }; },
    async recipientView(envelopeId, r) { check("recipientView"); views.push({ envelopeId, clientUserId: r.clientUserId, returnUrl: r.returnUrl }); return `https://demo.docusign.net/fake-sign/${envelopeId}`; },
    async voidEnvelope(envelopeId, reason) { check("voidEnvelope"); const e = envelopes.get(envelopeId); if (e) { e.status = "voided"; e.voided = reason; } },
    async envelopeStatus(envelopeId) { return { envelopeId, ...(envelopes.has(envelopeId) ? { envelope: envelopes.get(envelopeId)!.status } : {}), recipients: [] }; },
    async download(envelopeId, which) { check("download"); return FAKE_PDF(`${which} ${envelopeId}`); }
  };
}
