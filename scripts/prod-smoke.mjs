// Read-only smoke test of a DEPLOYED site. Writes nothing and needs no database or secrets (unlike scripts/smoke.mjs, which inserts rows).
// Usage: APP_URL=https://www.example.com.au ADMIN_APP_URL=https://admin.example.com.au npm run smoke:prod
// Checks: health on both sites, key public pages answer 200, the public site hides /staff, the admin site hides public pages,
// protected APIs refuse anonymous callers, cron endpoints fail closed, security headers are present.
const clean = u => (u || "").replace(/\/$/, "");
const PUBLIC = clean(process.env.APP_URL), ADMIN = clean(process.env.ADMIN_APP_URL);
if (!PUBLIC) { console.error("APP_URL is required (public origin). ADMIN_APP_URL is optional."); process.exit(2); }

let failed = 0;
const ok = (name, pass, extra = "") => { console.log(`${pass ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); if (!pass) failed++; };
const get = async (url, init = {}) => {
  try { const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(30000), ...init }); return { status: r.status, headers: r.headers, text: await r.text() }; }
  catch (e) { return { status: 0, headers: new Headers(), text: String(e) }; }
};

for (const [label, base] of [["public", PUBLIC], ["admin", ADMIN]]) {
  if (!base) continue;
  if (!base.startsWith("https://")) ok(`${label} uses https`, false, base);
  const h = await get(`${base}/api/health`);
  ok(`${label} /api/health`, h.status === 200 && h.text.includes('"ok":true'), `status ${h.status}`);
}

// Public pages (any redirect to sign-in counts as served, a 404/5xx does not).
for (const p of ["/", "/plans", "/listings", "/login", "/signup", "/terms", "/market", "/manifest.webmanifest"]) {
  const r = await get(PUBLIC + p);
  ok(`public ${p}`, r.status === 200 || (r.status >= 300 && r.status < 400), `status ${r.status}`);
}

// Split: public must not serve staff; admin must not serve public pages.
for (const p of ["/staff", "/api/staff/me"]) {
  const r = await get(PUBLIC + p); ok(`public hides ${p}`, r.status === 404, `status ${r.status}`);
}
if (ADMIN) {
  const r = await get(ADMIN + "/plans"); ok("admin hides /plans", r.status === 404, `status ${r.status}`);
  const s = await get(ADMIN + "/staff"); ok("admin /staff reachable (sign-in or page)", s.status === 200 || (s.status >= 300 && s.status < 400), `status ${s.status}`);
}

// Anonymous callers are refused, never a 500.
for (const p of ["/api/me", "/api/offers", "/api/documents"]) {
  const r = await get(PUBLIC + p);
  ok(`anonymous ${p} refused`, [401, 403, 404, 405].includes(r.status), `status ${r.status}`);
}
// Cron endpoints fail closed: wrong secret must be 401, or 503 when the secret is not set yet. Never 200, never 5xx other than 503.
for (const p of ["/api/internal/elena-learning/run", "/api/internal/accounts/retention", "/api/internal/reports/run"]) {
  const r = await get(PUBLIC + p, { method: "POST", headers: { "x-cron-secret": "smoke-test-wrong-secret", "content-type": "application/json", Origin: PUBLIC }, body: "{}" });
  ok(`cron ${p} fails closed`, [401, 403, 503].includes(r.status), `status ${r.status}`);
}

const home = await get(PUBLIC + "/");
for (const hd of ["x-content-type-options", "strict-transport-security"]) ok(`header ${hd} on /`, home.headers.has(hd));
ok("no stack trace on a missing page", !/at .*\.(js|ts):\d+/.test((await get(PUBLIC + "/no-such-page-smoke")).text));

console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed.");
process.exit(failed ? 1 : 0);
