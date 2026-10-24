/**
 * Where to send someone after sign-in. Only same-site relative paths are allowed: one leading "/", then a short allowlist of
 * characters. That rejects "//host", backslashes, schemes (":"), "%" (so encoded variants), whitespace and control characters.
 */
const SAFE_NEXT = /^\/(?!\/)[A-Za-z0-9._~\-/?=&]{0,300}$/;

/** The state cookie is URL-encoded when set, so decode once, then validate the decoded value. */
export function safeNextFromCookie(raw: string | undefined): string | undefined {
  try {
    return raw === undefined ? undefined : safeNext(decodeURIComponent(raw));
  } catch {
    return undefined;
  }
}

export const safeNext =(v: string | null | undefined): string | undefined => (v && SAFE_NEXT.test(v) ? v : undefined);
