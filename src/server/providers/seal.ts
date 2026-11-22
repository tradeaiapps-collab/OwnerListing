import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
const keyOf = (b64: string | undefined): Buffer => {
  if (!b64 || !KEY_RE.test(b64)) throw new Error("PROVIDER_CREDENTIAL_KEY must be 32 random bytes in base64 (openssl rand -base64 32).");
  return Buffer.from(b64, "base64");
};

/** AES-256-GCM seal of a provider secret for provider_credentials.secret_sealed. Format: v1.<iv>.<tag>.<ciphertext> (base64url). */
export function sealSecret(plain: string, keyB64: string | undefined): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyOf(keyB64), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

/** Returns undefined for a wrong key, a damaged value or an unknown format (never throws on bad data). */
export function openSecret(sealed: string, keyB64: string | undefined): string | undefined {
  const [v, iv, tag, ct] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || !ct) return undefined;
  try {
    const d = createDecipheriv("aes-256-gcm", keyOf(keyB64), Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
  } catch { return undefined; }
}
