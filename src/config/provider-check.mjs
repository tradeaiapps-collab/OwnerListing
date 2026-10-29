// Plain JavaScript readiness check for the outside-provider keys (Google sign-in, MFA key, PayWay, SMTP, SMS, ABN Lookup, address suggestions, map tiles).
// Shared by scripts/check-providers.mjs (plain Node, cannot import TypeScript) and instrumentation.ts. Types: provider-check.d.mts.
// Mirrors the rules the real readers apply (src/server/auth/config.ts, src/domain/mfa.ts, src/domain/messaging-settings.ts,
// src/adapters/*); tests/provider-check.test.ts keeps the two in step. Reports key NAMES only, never values.

/** Values copied from a template instead of a real key. A deploy with one of these is refused by `npm run check:providers`. */
const PLACEHOLDER = /^(?:changeme|change[-_ ]?me|replace[-_ ]?me|placeholder|todo|tbd|x{3,}|dummy|example|test|secret|password|none|null|undefined|<[^>]*>|your[-_ ].*|.*\bREPLACE\b.*)$/i;
export const isPlaceholder = v => PLACEHOLDER.test(v.trim());

const MFA_KEY = /^[A-Za-z0-9+/]{43}=$/;
const ABN_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SMS_SENDER = /^(?:\+[1-9]\d{7,14}|(?=.*[A-Za-z])[A-Za-z0-9 ]{1,11}|MG[0-9a-fA-F]{32})$/;
const EMAIL = /^[^\s\x00-\x1f\x7f<>"',;()\\@]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\.[A-Za-z]{2,}$/;
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const SMTP_PORTS = ["25", "465", "587", "2525"];

/**
 * One entry per provider. required: production cannot run without it. Others are switched off safely when unset.
 * check(get) returns problems (key name plus what is wrong) for keys that ARE set; missing keys are found from `keys`.
 */
const PROVIDERS = [
  {
    id: "google", label: "Google sign-in", required: true,
    unlocks: "Owner, agent, buyer and staff sign-in.",
    whenOff: "Sign-in is off for everyone.",
    keys: ["SESSION_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"], urlKey: true,
    check(get, prod) {
      const p = [];
      const secret = get("SESSION_SECRET");
      if (secret && secret.length < 32) p.push("SESSION_SECRET must be at least 32 characters (openssl rand -base64 48).");
      const id = get("GOOGLE_CLIENT_ID");
      if (id && !id.endsWith(".apps.googleusercontent.com")) p.push("GOOGLE_CLIENT_ID should end with .apps.googleusercontent.com.");
      const urlName = get("APP_MODE") === "admin" ? "ADMIN_APP_URL" : "APP_URL";
      const url = get(urlName);
      if (url && !/^https?:\/\/[^/\s]+\/?$/.test(url)) p.push(`${urlName} must be an origin only, like https://www.example.com.au.`);
      else if (url && prod && !url.startsWith("https://")) p.push(`${urlName} must start with https:// in production.`);
      return p;
    }
  },
  {
    id: "mfa", label: "Two-step sign-in key", required: true,
    unlocks: "Authenticator and SMS codes after Google sign-in (required for owners and agents).",
    whenOff: "Owners and agents cannot finish signing in.",
    keys: ["MFA_SECRET_KEY"],
    check: get => (get("MFA_SECRET_KEY") && !MFA_KEY.test(get("MFA_SECRET_KEY")) ? ["MFA_SECRET_KEY must be 32 random bytes in base64 (openssl rand -base64 32)."] : [])
  },
  {
    id: "payway", label: "Westpac PayWay payments", required: false,
    unlocks: "Listing package checkout and the payment webhook.",
    whenOff: "Checkout says \"not available yet\"; nothing can be marked paid, so nothing publishes.",
    keys: ["PAYWAY_MERCHANT_ID", "PAYWAY_API_KEY", "PAYWAY_WEBHOOK_SECRET"],
    check: () => []
  },
  {
    id: "smtp", label: "Email (SMTP)", required: false, alsoIn: "/staff/messaging",
    unlocks: "Saved-search alerts and account emails.",
    whenOff: "No email is sent; the outbox records \"not_configured\".",
    keys: ["SMTP_HOST", "SMTP_PORT", "SMTP_FROM"], optionalKeys: ["SMTP_USER", "SMTP_PASSWORD"],
    check(get) {
      const p = [];
      if (get("SMTP_HOST") && !HOST.test(get("SMTP_HOST"))) p.push("SMTP_HOST must be a host name such as smtp.example.com.");
      if (get("SMTP_PORT") && !SMTP_PORTS.includes(get("SMTP_PORT"))) p.push("SMTP_PORT must be 25, 465, 587 or 2525.");
      if (get("SMTP_FROM") && !EMAIL.test(get("SMTP_FROM"))) p.push("SMTP_FROM must be an email address such as no-reply@example.com.au.");
      if (!get("SMTP_USER") !== !get("SMTP_PASSWORD")) p.push("SMTP_USER and SMTP_PASSWORD must be set together or not at all.");
      return p;
    }
  },
  {
    id: "sms", label: "SMS (Twilio-compatible)", required: false, alsoIn: "/staff/messaging",
    unlocks: "Mobile verification codes, SMS sign-in codes and SMS alerts.",
    whenOff: "No SMS is sent; MFA offers the authenticator app only and mobile verification says \"not available yet\".",
    keys: ["SMS_PROVIDER", "SMS_ACCOUNT_SID", "SMS_AUTH_TOKEN", "SMS_SENDER", "SMS_CODE_SECRET"], optionalKeys: ["SMS_API_KEY_SID"],
    check(get) {
      const p = [];
      if (get("SMS_PROVIDER") && get("SMS_PROVIDER") !== "twilio") p.push("SMS_PROVIDER must be twilio.");
      if (get("SMS_ACCOUNT_SID") && !/^AC[0-9a-fA-F]{32}$/.test(get("SMS_ACCOUNT_SID"))) p.push("SMS_ACCOUNT_SID starts with AC and has 34 characters.");
      if (get("SMS_API_KEY_SID") && !/^SK[0-9a-fA-F]{32}$/.test(get("SMS_API_KEY_SID"))) p.push("SMS_API_KEY_SID starts with SK and has 34 characters.");
      const token = get("SMS_AUTH_TOKEN");
      if (token && !(/^[\x21-\x7e]+$/.test(token) && token.length >= 16 && token.length <= 128)) p.push("SMS_AUTH_TOKEN must be 16 to 128 characters with no spaces.");
      if (get("SMS_SENDER") && !SMS_SENDER.test(get("SMS_SENDER"))) p.push("SMS_SENDER must be +61... number, a 1-11 character sender ID or an MG... messaging service SID.");
      if (get("SMS_CODE_SECRET") && get("SMS_CODE_SECRET").length < 32) p.push("SMS_CODE_SECRET must be at least 32 characters.");
      return p;
    }
  },
  {
    id: "abn", label: "ABN Lookup (ABR)", required: false,
    unlocks: "Confirming agent and business ABNs with the Australian Business Register.",
    whenOff: "ABNs are only checksum-checked and recorded as \"not confirmed\"; staff review them.",
    keys: ["ABN_LOOKUP_GUID"],
    check: get => (get("ABN_LOOKUP_GUID") && !ABN_GUID.test(get("ABN_LOOKUP_GUID")) ? ["ABN_LOOKUP_GUID must be the GUID the ABR emailed (8-4-4-4-12 hex)."] : [])
  },
  {
    id: "address", label: "Address suggestions (Google Places)", required: false,
    unlocks: "Street address suggestions in the listing form, which also fill suburb, state and postcode.",
    whenOff: "Suggestions come from Photon's public OpenStreetMap service (ADDRESS_PHOTON_URL for a self-hosted one), which is fair-use only and not for launch traffic.",
    keys: ["GOOGLE_PLACES_API_KEY"], // ADDRESS_PHOTON_URL alone is a complete setup, so it is only format-checked below
    check(get) {
      const p = [];
      if (get("GOOGLE_PLACES_API_KEY") && !/^AIza[0-9A-Za-z_-]{35}$/.test(get("GOOGLE_PLACES_API_KEY"))) p.push("GOOGLE_PLACES_API_KEY should start with AIza and have 39 characters.");
      if (get("ADDRESS_PHOTON_URL") && !/^https:\/\/[^/\s?#]+\/?$/.test(get("ADDRESS_PHOTON_URL"))) p.push("ADDRESS_PHOTON_URL must be an https origin only, like https://photon.example.com.");
      return p;
    }
  },
  {
    id: "maptiles", label: "Map tiles", required: true,
    unlocks: "The search map and the listing location picker.",
    whenOff: "The map falls back to OpenStreetMap's public tiles, which their usage policy forbids for production traffic.",
    keys: ["NEXT_PUBLIC_MAP_TILE_URL", "NEXT_PUBLIC_MAP_ATTRIBUTION"],
    check(get) {
      const url = get("NEXT_PUBLIC_MAP_TILE_URL");
      if (!url) return [];
      const p = [];
      if (!url.startsWith("https://")) p.push("NEXT_PUBLIC_MAP_TILE_URL must start with https://.");
      if (!["{z}", "{x}", "{y}"].every(t => url.includes(t))) p.push("NEXT_PUBLIC_MAP_TILE_URL must contain {z}, {x} and {y}.");
      return p;
    }
  }
];

/**
 * Status of every provider for this environment. Pure: reads only the env object passed in.
 * status: ready | off (no key set) | incomplete (some keys missing) | invalid (a set value is wrong or a placeholder).
 */
export function checkProviders(env, opts = {}) {
  const prod = opts.production ?? env.NODE_ENV === "production";
  const get = k => { const v = env[k]; return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined; };
  return PROVIDERS.map(p => {
    const keys = p.urlKey ? [...p.keys, get("APP_MODE") === "admin" ? "ADMIN_APP_URL" : "APP_URL"] : p.keys;
    const all = [...keys, ...(p.optionalKeys ?? [])];
    const missing = keys.filter(k => !get(k));
    const placeholders = all.filter(k => get(k) && isPlaceholder(get(k)));
    const problems = [...placeholders.map(k => `${k} looks like a placeholder, not a real value.`), ...p.check(get, prod)];
    const anySet = all.some(k => get(k));
    const status = problems.length ? "invalid" : missing.length === 0 ? "ready" : anySet ? "incomplete" : "off";
    // Blocks a production deploy: wrong values always; a half-set provider (unless the rest can come from the admin screen);
    // a required provider that is not ready.
    const blocking = prod && (status === "invalid" || (status === "incomplete" && !p.alsoIn) || (p.required && status !== "ready"));
    return { id: p.id, label: p.label, required: p.required, unlocks: p.unlocks, whenOff: p.whenOff, alsoIn: p.alsoIn ?? null, keys: all, status, missing, problems, blocking };
  });
}

/** Text report, one block per provider. Names only. */
export function formatReport(results) {
  const mark = { ready: "OK  ", off: "OFF ", incomplete: "PART", invalid: "BAD " };
  const lines = [];
  for (const r of results) {
    lines.push(`[${mark[r.status]}] ${r.label}${r.required ? " (required)" : ""}${r.blocking ? "  <- blocks deploy" : ""}`);
    if (r.status !== "ready") {
      if (r.missing.length) lines.push(`       missing: ${r.missing.join(", ")}`);
      for (const p of r.problems) lines.push(`       ${p}`);
      lines.push(`       until then: ${r.whenOff}`);
      if (r.alsoIn && r.status === "off") lines.push(`       (can instead be saved by an admin in ${r.alsoIn})`);
    }
  }
  return lines.join("\n");
}
