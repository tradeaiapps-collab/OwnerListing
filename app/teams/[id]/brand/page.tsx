"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { contrastRatio } from "../../../../src/domain/site-theme";
import { JSON_HEADERS } from "../../../listings/ui";

type Domain = { host: string; verified: boolean; dns: { type: string; name: string; value: string } | null; cname: string | null };
type Tenant = {
  id: string; status: "draft" | "active" | "suspended"; hasLogo: boolean; hasFavicon: boolean; logoUrl: string | null; domains: Domain[];
  brand: { name: string; tagline: string; primary: string; secondary: string; footerText: string };
};
const EMPTY = { name: "", tagline: "", primary: "#7a3e00", secondary: "#10243f", footerText: "" };
const STATUS: Record<Tenant["status"], string> = {
  draft: "Not live yet. Verify a domain, then the platform team approves your brand.",
  active: "Live. Visitors on your verified domain see your brand.",
  suspended: "Switched off by the platform team. Visitors see the platform brand."
};
const HEX = /^#[0-9a-f]{6}$/i;

async function call(url: string, method: string, body?: unknown): Promise<{ ok: boolean; data: any }> {
  try {
    const r = await fetch(url, { method, ...(body !== undefined ? { headers: JSON_HEADERS, body: JSON.stringify(body) } : {}) });
    return { ok: r.ok, data: await r.json().catch(() => ({})) };
  } catch {
    return { ok: false, data: { error: "Network problem. Try again." } };
  }
}
const readBase64 = (f: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
  r.onerror = () => reject(new Error("read"));
  r.readAsDataURL(f);
});

/** Agency branding for a team: name, colours, logo, footer and custom domains. Managers only. */
export default function BrandPage() {
  const teamId = String(useParams<{ id: string }>().id);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [host, setHost] = useState("");
  const [busy, setBusy] = useState(false);
  const [logoKey, setLogoKey] = useState(0);

  const apply = useCallback((t: Tenant | null) => { setTenant(t); if (t) setForm(t.brand); }, []);
  useEffect(() => {
    void (async () => {
      const r = await call(`/api/agency/white-label?teamId=${teamId}`, "GET");
      if (!r.ok) setLoadError(r.data.error ?? "Could not load.");
      else { apply(r.data.tenant); setLoaded(true); }
    })();
  }, [teamId, apply]);

  async function run(fn: () => Promise<{ ok: boolean; data: any }>, okText?: string) {
    setBusy(true); setMsg(null);
    const r = await fn();
    setBusy(false);
    if (r.ok) { if (r.data.tenant !== undefined) apply(r.data.tenant); setErrors({}); setMsg({ ok: true, text: r.data.message ?? okText ?? "Done." }); }
    else { setErrors(r.data.errors ?? {}); setMsg({ ok: false, text: r.data.error ?? "That did not work." }); }
    return r.ok;
  }
  const save = () => run(() => call("/api/agency/white-label", "PUT", { teamId, ...form }));
  const addDomain = async () => { if (await run(() => call("/api/agency/white-label/domains", "POST", { teamId, host }))) setHost(""); };
  const check = (h: string) => run(() => call("/api/agency/white-label/domains", "PUT", { teamId, host: h }));
  const remove = (h: string) => window.confirm(`Disconnect ${h}? Visitors on that address will see the platform site.`) && run(() => call("/api/agency/white-label/domains", "DELETE", { teamId, host: h }));
  async function upload(slot: "logo-light" | "favicon", file: File | undefined) {
    if (!file) return;
    if (file.size > 512 * 1024) return setMsg({ ok: false, text: "Choose an image under 512 KB." });
    const data = await readBase64(file).catch(() => "");
    const done = await run(async () => {
      const r = await call("/api/agency/white-label/asset", "POST", { teamId, slot, contentType: file.type, data });
      return r.ok ? { ok: true, data: { message: "Image uploaded.", tenant: (await call(`/api/agency/white-label?teamId=${teamId}`, "GET")).data.tenant } } : r;
    });
    if (done) setLogoKey(k => k + 1);
  }

  if (loadError) return <main className="team-page"><p role="alert">{loadError}</p><p><Link href={`/teams/${teamId}`}>Back to the team</Link></p></main>;
  if (!loaded) return <main className="team-page"><p className="muted" role="status">Loading…</p></main>;

  const set = (k: keyof typeof EMPTY, v: string) => setForm(f => ({ ...f, [k]: v }));
  const valid = HEX.test(form.primary) && HEX.test(form.secondary);
  const ratio = valid ? contrastRatio(form.primary.toLowerCase(), "#fbfaf7") : 0;
  const err = (k: string) => (errors[k] ? <small className="wl-err" role="alert">{errors[k]}</small> : null);
  const colour = (k: "primary" | "secondary", label: string, hint: string) => (
    <div className="wl-field">
      <label htmlFor={`wl-${k}`}>{label} <span className="muted">· {hint}</span></label>
      <div className="wl-colour">
        <input type="color" aria-label={`${label} picker`} value={HEX.test(form[k]) ? form[k].toLowerCase() : "#000000"} onChange={e => set(k, e.target.value)} />
        <input id={`wl-${k}`} value={form[k]} maxLength={7} spellCheck={false} onChange={e => set(k, e.target.value)} aria-invalid={!!errors[k]} />
      </div>{err(k)}
    </div>
  );

  return (
    <main className="team-page wl">
      <p><Link href={`/teams/${teamId}`}>Back to the team</Link></p>
      <h1>Agency brand</h1>
      <p className="muted">Show your own name, colours and logo on your own web address. Listings, accounts and payments stay on the shared platform.</p>
      {tenant && <p className="wl-status" data-status={tenant.status} role="status"><strong>{tenant.status === "draft" ? "Draft" : tenant.status === "active" ? "Live" : "Suspended"}.</strong> {STATUS[tenant.status]}</p>}
      {msg && <p role={msg.ok ? "status" : "alert"} className={msg.ok ? "wl-ok" : "wl-bad"}>{msg.text}</p>}

      <section className="team-card" aria-labelledby="wl-brand-h">
        <h2 id="wl-brand-h">Name and colours</h2>
        <div className="wl-form">
          <div className="wl-field"><label htmlFor="wl-name">Agency name</label><input id="wl-name" value={form.name} maxLength={60} onChange={e => set("name", e.target.value)} aria-invalid={!!errors["name"]} />{err("name")}</div>
          <div className="wl-field"><label htmlFor="wl-tag">Tagline <span className="muted">· optional</span></label><input id="wl-tag" value={form.tagline} maxLength={120} onChange={e => set("tagline", e.target.value)} aria-invalid={!!errors["tagline"]} />{err("tagline")}</div>
          {colour("primary", "Accent colour", "links and highlights")}
          {colour("secondary", "Main colour", "headings, header text and buttons")}
          <div className="wl-field"><label htmlFor="wl-foot">Footer line <span className="muted">· optional, e.g. licence number</span></label><input id="wl-foot" value={form.footerText} maxLength={200} onChange={e => set("footerText", e.target.value)} />{err("footerText")}</div>
        </div>
        {Object.entries(errors).filter(([k]) => !(k in form)).map(([k, v]) => <p key={k} className="wl-err" role="alert">{v}</p>)}
        <div className="wl-preview" aria-label="Preview" style={{ background: "#fbfaf7", borderColor: HEX.test(form.secondary) ? form.secondary : undefined }}>
          <span className="wl-preview-bar" style={{ color: HEX.test(form.secondary) ? form.secondary : undefined }}>
            {tenant?.logoUrl ? <img key={logoKey} src={`${tenant.logoUrl}&k=${logoKey}`} alt="" height={28} /> : null}
            <strong>{form.name || "Your agency"}</strong>
          </span>
          <span className="wl-preview-link" style={{ color: HEX.test(form.primary) ? form.primary : undefined }}>Browse homes</span>
          <span className="wl-preview-btn" style={{ background: HEX.test(form.secondary) ? form.secondary : undefined }}>Make an offer</span>
        </div>
        {valid && <p className="muted">Accent colour contrast on the page background: {ratio.toFixed(1)}:1 (at least 4.5:1 is needed for links).</p>}
        <p><button type="button" onClick={save} disabled={busy || !form.name.trim()}>{tenant ? "Save brand" : "Create brand"}</button></p>
      </section>

      {tenant && (
        <section className="team-card" aria-labelledby="wl-img-h">
          <h2 id="wl-img-h">Logo and favicon</h2>
          <p className="muted">PNG, JPEG or WebP under 512 KB (favicon: PNG or ICO). A new logo needs platform approval again if your brand is live.</p>
          <div className="wl-form">
            <div className="wl-field"><label htmlFor="wl-logo">Logo {tenant.hasLogo && <span className="muted">· uploaded</span>}</label><input id="wl-logo" type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={e => void upload("logo-light", e.target.files?.[0])} /></div>
            <div className="wl-field"><label htmlFor="wl-fav">Favicon {tenant.hasFavicon && <span className="muted">· uploaded</span>}</label><input id="wl-fav" type="file" accept="image/png,image/x-icon,image/vnd.microsoft.icon" disabled={busy} onChange={e => void upload("favicon", e.target.files?.[0])} /></div>
          </div>
        </section>
      )}

      {tenant && (
        <section className="team-card" aria-labelledby="wl-dom-h">
          <h2 id="wl-dom-h">Your web addresses</h2>
          <p className="muted">Use a subdomain you own, such as homes.youragency.com.au. Point it at us with a CNAME record, and add the TXT record below to prove it is yours.</p>
          <div className="wl-add">
            <div className="wl-field"><label htmlFor="wl-host">Domain</label><input id="wl-host" value={host} placeholder="homes.youragency.com.au" spellCheck={false} autoCapitalize="none" onChange={e => setHost(e.target.value)} /></div>
            <button type="button" onClick={addDomain} disabled={busy || !host.trim()}>Add domain</button>
          </div>
          {tenant.domains.length === 0 ? <p className="muted">No domains yet.</p> : (
            <ul className="wl-domains">
              {tenant.domains.map(d => (
                <li key={d.host}>
                  <div className="wl-dom-head"><strong className="wl-host">{d.host}</strong><span className="wl-badge" data-ok={d.verified}>{d.verified ? "Verified" : "Not verified"}</span></div>
                  {d.dns && (
                    <dl className="wl-dns">
                      <div><dt>TXT name</dt><dd><code>{d.dns.name}</code></dd></div>
                      <div><dt>TXT value</dt><dd><code>{d.dns.value}</code></dd></div>
                      {d.cname && <div><dt>CNAME</dt><dd><code>{d.host} → {d.cname}</code></dd></div>}
                    </dl>
                  )}
                  <p className="wl-dom-actions">
                    {!d.verified && <button type="button" className="secondary" onClick={() => void check(d.host)} disabled={busy}>Check now</button>}
                    <button type="button" className="secondary" onClick={() => void remove(d.host)} disabled={busy}>Remove</button>
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}
