import { OfferLinkKeyError, openOfferToken, sealOfferToken } from "./offer-link-crypto";

/** Secret settings (SMS auth token, SMTP password) are sealed with AES-256-GCM under MESSAGING_SETTINGS_KEY (32 bytes, base64). */
export class MessagingKeyError extends Error {
  constructor() { super("MESSAGING_SETTINGS_KEY is missing or not 32 bytes of base64."); this.name = "MessagingKeyError"; }
}

export const messagingKeyUsable = (key: string | undefined): boolean => /^[A-Za-z0-9+/]{43}=$/.test(key?.trim() ?? "");

const aad = (field: string) => `messaging-setting:${field}`;

/** Binds the ciphertext to its field, so one sealed value cannot be copied into another row. Throws MessagingKeyError when the key is unusable. */
export async function sealSetting(value: string, key: string | undefined, field: string): Promise<string> {
  if (!messagingKeyUsable(key)) throw new MessagingKeyError();
  try {
    return await sealOfferToken(value, key, aad(field));
  } catch (e) {
    throw e instanceof OfferLinkKeyError ? new MessagingKeyError() : e;
  }
}

/** The value, or undefined when it was tampered with, belongs to another field, or the key is wrong. Throws MessagingKeyError when the key is unusable. */
export async function openSetting(sealed: string, key: string | undefined, field: string): Promise<string | undefined> {
  if (!messagingKeyUsable(key)) throw new MessagingKeyError();
  try {
    return await openOfferToken(sealed, key, aad(field));
  } catch (e) {
    throw e instanceof OfferLinkKeyError ? new MessagingKeyError() : e;
  }
}
