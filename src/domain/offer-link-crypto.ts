/**
 * AES-256-GCM sealing for the offer link token held between "owner issued" and "buyer opened it".
 * Pure: the key is passed in (base64, exactly 32 bytes), never read from the environment here.
 * Fails closed: a missing or malformed key throws OfferLinkKeyError and nothing is sealed or opened.
 * Format: "v1." + base64(iv[12] | ciphertext+tag). A fresh random IV is used for every seal.
 * `aad` binds the ciphertext to its row (the request id), so it cannot be copied to another row.
 */
export class OfferLinkKeyError extends Error {
  constructor(message = "OFFER_LINK_TOKEN_KEY is missing or not 32 bytes of base64.") { super(message); this.name = "OfferLinkKeyError"; }
}

const VERSION = "v1.";
const IV_BYTES = 12;
const enc = new TextEncoder();

function fromB64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
function toB64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

async function importKey(keyB64: string | undefined): Promise<CryptoKey> {
  const k = keyB64?.trim();
  if (!k || !/^[A-Za-z0-9+/]{43}=$/.test(k)) throw new OfferLinkKeyError();
  const raw = fromB64(k);
  if (raw.length !== 32) throw new OfferLinkKeyError();
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function sealOfferToken(token: string, keyB64: string | undefined, aad: string): Promise<string> {
  const key = await importKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, key, enc.encode(token)));
  const out = new Uint8Array(IV_BYTES + ct.length);
  out.set(iv);
  out.set(ct, IV_BYTES);
  return VERSION + toB64(out);
}

/** The token, or undefined when the data was tampered with, belongs to another row, or the key is wrong. Throws OfferLinkKeyError when the key is unusable. */
export async function openOfferToken(sealed: string, keyB64: string | undefined, aad: string): Promise<string | undefined> {
  const key = await importKey(keyB64);
  try {
    if (!sealed.startsWith(VERSION)) return undefined;
    const raw = fromB64(sealed.slice(VERSION.length));
    if (raw.length < IV_BYTES + 16) return undefined;
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: raw.slice(0, IV_BYTES) as BufferSource, additionalData: enc.encode(aad) }, key, raw.slice(IV_BYTES) as BufferSource
    );
    return new TextDecoder().decode(pt);
  } catch {
    return undefined;
  }
}
