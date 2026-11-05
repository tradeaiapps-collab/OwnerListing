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

const API_BASE = /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::\d{2,5})?(?:\/[A-Za-z0-9._~\/-]*)?$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,60}$/;
/** Shared rules for the providers reached over a plain HTTPS API (MLS, Zillow): key, base URL, optional header/path/rate/webhook secret. */
function httpApiProblems(get, P) {
  const p = [];
  const key = get(`${P}_API_KEY`);
  if (key && !(/^[\x21-\x7e]+$/.test(key) && key.length >= 16 && key.length <= 512)) p.push(`${P}_API_KEY must be 16 to 512 characters with no spaces.`);
  const base = get(`${P}_API_BASE_URL`);
  if (base && !API_BASE.test(base)) p.push(`${P}_API_BASE_URL must be an https URL with no query, like https://api.example.com/v1.`);
  const header = get(`${P}_API_KEY_HEADER`);
  if (header && !HEADER_NAME.test(header)) p.push(`${P}_API_KEY_HEADER must be a header name like X-Api-Key (unset = Authorization: Bearer).`);
  const path = get(`${P}_HEALTH_PATH`);
  if (path && !/^\/[A-Za-z0-9._~\/-]*$/.test(path)) p.push(`${P}_HEALTH_PATH must start with / (default /).`);
  const rate = get(`${P}_RATE_PER_SECOND`);
  if (rate && !(Number(rate) > 0 && Number(rate) <= 100)) p.push(`${P}_RATE_PER_SECOND must be a number from 0.1 to 100 (default 5).`);
  const hook = get(`${P}_WEBHOOK_SECRET`);
  if (hook && hook.length < 32) p.push(`${P}_WEBHOOK_SECRET must be at least 32 characters.`);
  return p;
}
const pushHookProblem = get => (get("PUSH_STATUS_WEBHOOK_SECRET") && get("PUSH_STATUS_WEBHOOK_SECRET").length < 32 ? ["PUSH_STATUS_WEBHOOK_SECRET must be at least 32 characters."] : []);

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
    id: "webpush", label: "Browser push (Web Push, VAPID)", required: false,
    unlocks: "Push notifications to Chrome, Edge, Firefox and Safari (including Home Screen apps).",
    whenOff: "Browsers cannot subscribe and no browser push is sent; in-app, email and SMS are unaffected.",
    keys: ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"],
    check(get) {
      const p = [];
      if (get("VAPID_PUBLIC_KEY") && !/^[A-Za-z0-9_-]{87}$/.test(get("VAPID_PUBLIC_KEY"))) p.push("VAPID_PUBLIC_KEY must be the 87-character base64url public key (npx web-push generate-vapid-keys).");
      if (get("VAPID_PRIVATE_KEY") && !/^[A-Za-z0-9_-]{43}$/.test(get("VAPID_PRIVATE_KEY"))) p.push("VAPID_PRIVATE_KEY must be the 43-character base64url private key from the same pair.");
      if (get("VAPID_SUBJECT") && !/^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/.test(get("VAPID_SUBJECT"))) p.push("VAPID_SUBJECT must be mailto:you@example.com.au or an https URL.");
      return p;
    }
  },
  {
    id: "fcm", label: "Android push (Firebase Cloud Messaging)", required: false,
    unlocks: "Push notifications to the Android app.",
    whenOff: "Android devices are not pushed to; the app still shows the in-app inbox.",
    keys: ["FCM_PROJECT_ID", "FCM_CLIENT_EMAIL", "FCM_PRIVATE_KEY"], optionalKeys: ["PUSH_STATUS_WEBHOOK_SECRET"],
    check(get) {
      const p = pushHookProblem(get);
      if (get("FCM_PROJECT_ID") && !/^[a-z][a-z0-9-]{4,29}$/.test(get("FCM_PROJECT_ID"))) p.push("FCM_PROJECT_ID is the Firebase project id (lower case letters, digits and dashes).");
      if (get("FCM_CLIENT_EMAIL") && !/^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/.test(get("FCM_CLIENT_EMAIL"))) p.push("FCM_CLIENT_EMAIL must be the service account email ending .iam.gserviceaccount.com.");
      if (get("FCM_PRIVATE_KEY") && !get("FCM_PRIVATE_KEY").replace(/\\n/g, "\n").trim().startsWith("-----BEGIN")) p.push("FCM_PRIVATE_KEY must be the service account private key (-----BEGIN PRIVATE KEY-----).");
      return p;
    }
  },
  {
    id: "apns", label: "iPhone push (Apple APNs)", required: false,
    unlocks: "Push notifications to the iPhone app.",
    whenOff: "iPhones are not pushed to; the app still shows the in-app inbox.",
    keys: ["APNS_KEY_ID", "APNS_TEAM_ID", "APNS_BUNDLE_ID", "APNS_PRIVATE_KEY"], optionalKeys: ["APNS_PRODUCTION", "PUSH_STATUS_WEBHOOK_SECRET"],
    check(get) {
      const p = pushHookProblem(get);
      if (get("APNS_KEY_ID") && !/^[A-Z0-9]{10}$/.test(get("APNS_KEY_ID"))) p.push("APNS_KEY_ID is the 10-character key id from Apple Developer.");
      if (get("APNS_TEAM_ID") && !/^[A-Z0-9]{10}$/.test(get("APNS_TEAM_ID"))) p.push("APNS_TEAM_ID is the 10-character Apple team id.");
      if (get("APNS_BUNDLE_ID") && !/^[A-Za-z0-9.-]+$/.test(get("APNS_BUNDLE_ID"))) p.push("APNS_BUNDLE_ID is the app's bundle id, like au.com.example.ownerlisting.");
      if (get("APNS_PRIVATE_KEY") && !get("APNS_PRIVATE_KEY").replace(/\\n/g, "\n").trim().startsWith("-----BEGIN")) p.push("APNS_PRIVATE_KEY must be the .p8 key contents (-----BEGIN PRIVATE KEY-----).");
      if (get("APNS_PRODUCTION") && !["0", "1"].includes(get("APNS_PRODUCTION"))) p.push("APNS_PRODUCTION is 1 for the live APNs service, or 0/unset for the sandbox.");
      return p;
    }
  },
  {
    id: "mls", label: "MLS property data", required: false,
    unlocks: "Syncing listed property data from the MLS feed, and the MLS update webhook (/api/webhooks/mls).",
    whenOff: "No MLS data is fetched; the webhook answers 503. Owner-entered listings are unaffected.",
    keys: ["MLS_API_KEY", "MLS_API_BASE_URL"],
    optionalKeys: ["MLS_WEBHOOK_SECRET", "MLS_API_KEY_HEADER", "MLS_HEALTH_PATH", "MLS_RATE_PER_SECOND"],
    check: get => httpApiProblems(get, "MLS")
  },
  {
    id: "zillow", label: "Zillow property data", required: false,
    unlocks: "Property details and estimates from Zillow.",
    whenOff: "No Zillow data is fetched; price guidance keeps using the configured comparables source only.",
    keys: ["ZILLOW_API_KEY", "ZILLOW_API_BASE_URL"],
    optionalKeys: ["ZILLOW_API_KEY_HEADER", "ZILLOW_HEALTH_PATH", "ZILLOW_RATE_PER_SECOND"],
    check: get => httpApiProblems(get, "ZILLOW")
  },
  {
    id: "providercreds", label: "Provider credential encryption", required: false,
    unlocks: "Storing a per-agent or per-team provider connection (provider_credentials) with its secret encrypted.",
    whenOff: "No per-agent or per-team provider connection can be saved; platform-wide keys above still work.",
    keys: ["PROVIDER_CREDENTIAL_KEY"],
    check: get => (get("PROVIDER_CREDENTIAL_KEY") && !MFA_KEY.test(get("PROVIDER_CREDENTIAL_KEY")) ? ["PROVIDER_CREDENTIAL_KEY must be 32 random bytes in base64 (openssl rand -base64 32)."] : [])
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
    // Mirrors src/domain/map-tiles.ts: openstreetmap needs no key; custom needs a tile URL and attribution; a URL without a provider is custom.
    id: "maptiles", label: "Map tiles", required: true,
    unlocks: "The listing page map, the search map, the staff listings map and the location picker.",
    whenOff: "The maps fall back to OpenStreetMap's public tiles. Set NEXT_PUBLIC_MAP_PROVIDER=openstreetmap to choose them on purpose.",
    keys: ["NEXT_PUBLIC_MAP_PROVIDER"], optionalKeys: ["NEXT_PUBLIC_MAP_TILE_URL", "NEXT_PUBLIC_MAP_ATTRIBUTION"],
    keysFor(get) {
      const provider = get("NEXT_PUBLIC_MAP_PROVIDER")?.toLowerCase() ?? (get("NEXT_PUBLIC_MAP_TILE_URL") ? "custom" : undefined);
      return provider === "custom" ? ["NEXT_PUBLIC_MAP_TILE_URL", "NEXT_PUBLIC_MAP_ATTRIBUTION"] : ["NEXT_PUBLIC_MAP_PROVIDER"];
    },
    note(get) {
      const provider = get("NEXT_PUBLIC_MAP_PROVIDER")?.toLowerCase();
      return provider === "openstreetmap"
        ? "Using OpenStreetMap's public tiles (free, no key). Their tile policy allows light use with attribution only; switch to NEXT_PUBLIC_MAP_PROVIDER=custom (paid or self-hosted tiles) if traffic grows."
        : null;
    },
    check(get) {
      const p = [];
      const provider = get("NEXT_PUBLIC_MAP_PROVIDER")?.toLowerCase();
      if (provider && provider !== "openstreetmap" && provider !== "custom") p.push("NEXT_PUBLIC_MAP_PROVIDER must be openstreetmap or custom.");
      if (provider === "openstreetmap" && get("NEXT_PUBLIC_MAP_TILE_URL")) p.push("NEXT_PUBLIC_MAP_TILE_URL is ignored with NEXT_PUBLIC_MAP_PROVIDER=openstreetmap: remove it, or set the provider to custom.");
      const url = get("NEXT_PUBLIC_MAP_TILE_URL");
      if (!url || provider === "openstreetmap") return p;
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
    const base = p.keysFor ? p.keysFor(get) : p.keys;
    const keys = p.urlKey ? [...base, get("APP_MODE") === "admin" ? "ADMIN_APP_URL" : "APP_URL"] : base;
    const all = [...new Set([...p.keys, ...keys, ...(p.optionalKeys ?? [])])];
    const missing = keys.filter(k => !get(k));
    const placeholders = all.filter(k => get(k) && isPlaceholder(get(k)));
    const problems = [...placeholders.map(k => `${k} looks like a placeholder, not a real value.`), ...p.check(get, prod)];
    const anySet = all.some(k => get(k));
    const status = problems.length ? "invalid" : missing.length === 0 ? "ready" : anySet ? "incomplete" : "off";
    // Blocks a production deploy: wrong values always; a half-set provider (unless the rest can come from the admin screen);
    // a required provider that is not ready.
    const blocking = prod && (status === "invalid" || (status === "incomplete" && !p.alsoIn) || (p.required && status !== "ready"));
    return { id: p.id, label: p.label, required: p.required, unlocks: p.unlocks, whenOff: p.whenOff, alsoIn: p.alsoIn ?? null, keys: all, status, missing, problems, blocking,
      note: status === "ready" && p.note ? p.note(get) : null };
  });
}

/** Text report, one block per provider. Names only. */
export function formatReport(results) {
  const mark = { ready: "OK  ", off: "OFF ", incomplete: "PART", invalid: "BAD " };
  const lines = [];
  for (const r of results) {
    lines.push(`[${mark[r.status]}] ${r.label}${r.required ? " (required)" : ""}${r.blocking ? "  <- blocks deploy" : ""}`);
    if (r.note) lines.push(`       note: ${r.note}`);
    if (r.status !== "ready") {
      if (r.missing.length) lines.push(`       missing: ${r.missing.join(", ")}`);
      for (const p of r.problems) lines.push(`       ${p}`);
      lines.push(`       until then: ${r.whenOff}`);
      if (r.alsoIn && r.status === "off") lines.push(`       (can instead be saved by an admin in ${r.alsoIn})`);
    }
  }
  return lines.join("\n");
}
