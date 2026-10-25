"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "../../styles/staff.css";
import "../../styles/site-editor.css";
import { loadError } from "../staff-api";
import {
  BUTTON_SIZES, COLOUR_KEYS, DENSITIES, ICON_STYLES, LIMITS, RANGES, contrastRatio, validateTheme,
  type ColourKey, type NavItem, type ThemeErrors, type ThemeSettings
} from "../../../src/domain/site-theme";

interface VersionRow {
  version: number; source: "save" | "revert" | "reset"; revertedFrom: number | null; createdBy: string; createdAt: string;
  publishedAt: string | null; publishedBy: string | null; live: boolean; draft: boolean;
}
interface View {
  draftVersion: number | null; publishedVersion: number | null; draft: ThemeSettings; published: ThemeSettings; defaults: ThemeSettings; versions: VersionRow[];
  options: { fonts: { id: string; label: string; stack: string; webFont: boolean }[]; nav: { id: string; label: string; href: string }[] };
}
type Section = "brand" | "colours" | "typography" | "layout" | "navigation" | "footer" | "history";
const SECTIONS: { id: Section; label: string }[] = [
  { id: "brand", label: "Brand" }, { id: "colours", label: "Colours" }, { id: "typography", label: "Typography" }, { id: "layout", label: "Layout" },
  { id: "navigation", label: "Navigation" }, { id: "footer", label: "Footer" }, { id: "history", label: "History" }
];
const COLOUR_LABELS: Record<ColourKey, [string, string]> = {
  primary: ["Primary", "Focus ring and highlights"], secondary: ["Secondary", "Secondary buttons and text"], accent: ["Accent", "Hover underline and form controls"],
  headerBg: ["Header background", "Top bar and footer"], headerText: ["Header text", "Top bar links and footer text"], link: ["Links", "Links in the page"],
  buttonBg: ["Button background", "Main buttons"], buttonText: ["Button text", "Text on main buttons"], bg: ["Page background", ""], surface: ["Surface", "Cards and panels"],
  text: ["Text", "Body text"], heading: ["Headings", ""], muted: ["Muted text", "Hints and captions"], border: ["Border", "Lines and outlines"]
};
const SLOTS = [["logo-light", "logoLight", "Logo (light mode)"], ["logo-dark", "logoDark", "Logo (dark mode)"], ["favicon", "favicon", "Favicon"], ["hero", "hero", "Home hero photo"]] as const;

function setIn<T>(obj: T, path: string, value: unknown): T {
  const next = structuredClone(obj) as Record<string, unknown>;
  const keys = path.split(".");
  let cur: Record<string, unknown> = next;
  for (const k of keys.slice(0, -1)) cur = cur[k] as Record<string, unknown>;
  cur[keys[keys.length - 1]!] = value;
  return next as T;
}
const getIn = (obj: unknown, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);

export default function StaffSite() {
  const [view, setView] = useState<View | null>(null);
  const [s, setS] = useState<ThemeSettings | null>(null);
  const [section, setSection] = useState<Section>("brand");
  const [mode, setMode] = useState<"light" | "dark">("light");
  const [previewMode, setPreviewMode] = useState<"system" | "light" | "dark">("system");
  const [width, setWidth] = useState<"desktop" | "mobile">("desktop");
  const [serverErrors, setServerErrors] = useState<ThemeErrors>({});
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ url: string; origin: string } | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [frameKey, setFrameKey] = useState(0);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const frame = useRef<HTMLIFrameElement>(null);

  const apply = useCallback((v: View) => { setView(v); setS(structuredClone(v.draft)); setServerErrors({}); }, []);

  const load = useCallback(async () => {
    const r = await fetch("/api/staff/site").catch(() => null);
    if (!r) { setError("Could not load."); return; }
    if (!r.ok) { setError(loadError(r.status)); return; }
    apply(await r.json());
  }, [apply]);
  useEffect(() => { void load(); }, [load]);

  const refreshPreview = useCallback(async () => {
    const r = await fetch("/api/staff/site/preview", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    if (r?.ok) { setPreview({ url: d.url, origin: d.origin || window.location.origin }); setPreviewError(""); }
    else setPreviewError(d.error ?? "Preview is not available.");
  }, []);
  useEffect(() => {
    if (!view) return;
    void refreshPreview();
    const t = setInterval(() => void refreshPreview(), 12 * 60 * 1000);
    return () => clearInterval(t);
  }, [view === null, refreshPreview]); // eslint-disable-line react-hooks/exhaustive-deps

  const clientErrors = useMemo<ThemeErrors>(() => {
    if (!s) return {};
    const r = validateTheme(s);
    return r.ok ? {} : r.errors;
  }, [s]);
  const errors = { ...serverErrors, ...clientErrors };
  const dirty = !!view && !!s && JSON.stringify(s) !== JSON.stringify(view.draft);

  // Push the settings being edited into the preview frame as they change (the frame validates and builds the CSS itself).
  const post = useCallback(() => {
    const w = frame.current?.contentWindow;
    if (!w || !s || !preview) return;
    w.postMessage({ type: "ol-theme-draft", settings: s, mode: previewMode === "system" ? null : previewMode }, preview.origin);
  }, [s, preview, previewMode]);
  useEffect(() => { const t = setTimeout(post, 120); return () => clearTimeout(t); }, [post]);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => { if (preview && e.origin === preview.origin && e.data?.type === "ol-theme-ready") post(); };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [preview, post]);

  const set = (path: string, value: unknown) => setS(cur => (cur ? setIn(cur, path, value) : cur));

  async function call(url: string, method: string, body: unknown, ok: string) {
    setBusy(true); setError(""); setNote("");
    try {
      const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
      const d = r ? await r.json().catch(() => ({})) : {};
      if (r?.ok) {
        apply({ ...(view as View), ...d }); setNote(ok); setFrameKey(k => k + 1);
        return true;
      }
      setServerErrors(d.fields ?? {});
      setError(d.error ?? "Could not complete that.");
    } finally { setBusy(false); }
    return false;
  }

  const save = () => s && call("/api/staff/site", "PUT", { baseVersion: view!.draftVersion, settings: s }, "Draft saved. Use Publish to make it live.");
  const publish = () => call("/api/staff/site/publish", "POST", { version: view!.draftVersion }, "Published. The public site picks it up within about a minute.");
  const revert = (v: number) => window.confirm(`Revert the live site to version ${v}? This creates a new version and goes live at once.`) && call("/api/staff/site/revert", "POST", { version: v }, `Reverted to version ${v} as a new version, now live.`);
  const resetAll = () => window.confirm("Reset everything to the built-in defaults? This replaces your draft (it does not go live until you publish).") && call("/api/staff/site/reset", "POST", { baseVersion: view!.draftVersion }, "Draft reset to the built-in defaults. Publish to make it live.");
  const resetSection = (paths: string[]) => { if (view) setS(cur => paths.reduce((acc, p) => setIn(acc!, p, structuredClone(getIn(view.defaults, p))), cur)); };

  async function upload(slot: (typeof SLOTS)[number], file: File | undefined) {
    if (!file) return;
    setError(""); setNote("");
    const max = slot[0] === "hero" ? 1536 * 1024 : 512 * 1024;
    if (file.size > max) { setError(`That file is larger than ${slot[0] === "hero" ? "1.5 MB" : "512 KB"}.`); return; }
    const data = await new Promise<string>((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result).split(",")[1] ?? "");
      fr.onerror = () => rej(new Error("read"));
      fr.readAsDataURL(file);
    }).catch(() => "");
    const r = await fetch("/api/staff/site/asset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: slot[0], contentType: file.type, data }) }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    if (!r?.ok) { setError(d.error ?? "Upload failed."); return; }
    set(`brand.${slot[1]}`, d.id);
    setThumbs(t => ({ ...t, [slot[0]]: URL.createObjectURL(file) }));
    setNote(`${slot[2]} uploaded (${d.width} by ${d.height}). Save the draft to keep it.`);
  }
  const thumbFor = (slot: (typeof SLOTS)[number]) => {
    if (thumbs[slot[0]]) return thumbs[slot[0]];
    const id = s?.brand[slot[1]];
    const tok = preview ? new URL(preview.url, window.location.origin).searchParams.get("theme_preview") : null;
    return id && tok ? `/api/site/asset/${slot[0]}?v=${id}&theme_preview=${encodeURIComponent(tok)}` : null;
  };

  if (!view || !s) return <main><h1>Site appearance</h1>{error ? <p role="alert">{error}</p> : <p className="muted">Loading…</p>}</main>;

  const err = (p: string) => (errors[p] ? <small className="se-err" role="alert">{errors[p]}</small> : null);
  const Text = ({ label, path, max, nullable, hint }: { label: string; path: string; max: number; nullable?: boolean; hint?: string }) => {
    const v = getIn(s, path) as string | null;
    return (
      <label className="se-field">{label}
        <input value={v ?? ""} maxLength={max} onChange={e => set(path, nullable && e.target.value === "" ? null : e.target.value)} aria-invalid={!!errors[path]} />
        {hint && <small className="muted">{hint}</small>}{err(path)}
      </label>
    );
  };
  const Num = ({ label, path, range, step = 1, unit = "px" }: { label: string; path: string; range: readonly [number, number]; step?: number; unit?: string }) => {
    const v = getIn(s, path) as number;
    return (
      <div className="se-field">
        <label htmlFor={`n-${path}`}>{label} <span className="muted">({range[0]} to {range[1]}{unit})</span></label>
        <div className="se-num">
          <input type="range" aria-label={`${label} slider`} min={range[0]} max={range[1]} step={step} value={Number.isFinite(v) ? v : range[0]} onChange={e => set(path, Number(e.target.value))} />
          <input id={`n-${path}`} type="number" min={range[0]} max={range[1]} step={step} value={Number.isFinite(v) ? v : ""} onChange={e => set(path, e.target.value === "" ? NaN : Number(e.target.value))} aria-invalid={!!errors[path]} />
        </div>{err(path)}
      </div>
    );
  };
  const Choice = ({ label, path, options }: { label: string; path: string; options: readonly (string | { id: string; label: string })[] }) => (
    <label className="se-field">{label}
      <select value={String(getIn(s, path))} onChange={e => set(path, e.target.value)}>
        {options.map(o => typeof o === "string" ? <option key={o} value={o}>{o}</option> : <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>{err(path)}
    </label>
  );
  const ColourField = ({ k }: { k: ColourKey }) => {
    const path = `colours.${mode}.${k}`;
    const v = String(getIn(s, path));
    const valid = /^#[0-9a-f]{6}$/i.test(v);
    return (
      <div className="se-field se-colour">
        <label htmlFor={`c-${path}`}>{COLOUR_LABELS[k][0]}{COLOUR_LABELS[k][1] && <span className="muted"> · {COLOUR_LABELS[k][1]}</span>}</label>
        <div className="se-colour-row">
          <input type="color" aria-label={`${COLOUR_LABELS[k][0]} picker`} value={valid ? v.toLowerCase() : "#000000"} onChange={e => set(path, e.target.value)} />
          <input id={`c-${path}`} value={v} maxLength={7} spellCheck={false} onChange={e => set(path, e.target.value)} aria-invalid={!!errors[path]} />
        </div>{err(path)}
      </div>
    );
  };
  const mc = s.colours[mode];
  const swatch = (fg: ColourKey, bg: ColourKey, label: string) => {
    const ok = /^#[0-9a-f]{6}$/i.test(mc[fg]) && /^#[0-9a-f]{6}$/i.test(mc[bg]);
    const ratio = ok ? contrastRatio(mc[fg].toLowerCase(), mc[bg].toLowerCase()) : 0;
    return <span className="se-swatch" style={{ color: mc[fg], background: mc[bg] }}>{label} <b>{ok ? `${ratio.toFixed(1)}:1` : "?"}</b></span>;
  };
  const moveNav = (i: number, d: -1 | 1) => setS(cur => {
    if (!cur) return cur;
    const j = i + d; if (j < 0 || j >= cur.navigation.length) return cur;
    const nav = [...cur.navigation]; [nav[i], nav[j]] = [nav[j]!, nav[i]!];
    return { ...cur, navigation: nav };
  });
  const hasErrors = Object.keys(clientErrors).length > 0;
  const canPublish = !dirty && !hasErrors && view.draftVersion !== null && view.draftVersion !== view.publishedVersion && !busy;
  const framePx = width === "mobile" ? 390 : undefined;

  return (
    <main className="se">
      <header className="se-head">
        <div>
          <h1>Site appearance</h1>
          <p className="muted">Edits save as a draft. Preview shows the draft on the public site; Publish makes it live for everyone. Live: <b>{view.publishedVersion ? `version ${view.publishedVersion}` : "built-in defaults"}</b> · Draft: <b>{view.draftVersion ? `version ${view.draftVersion}` : "none"}</b>{dirty && <> · <b className="se-dirty">unsaved changes</b></>}</p>
        </div>
        <div className="se-actions">
          <button type="button" onClick={save} disabled={busy || !dirty || hasErrors}>Save draft</button>
          <button type="button" className="secondary" onClick={() => preview && window.open(preview.url, "_blank", "noopener")} disabled={!preview}>Open preview</button>
          <button type="button" onClick={publish} disabled={!canPublish}>Publish</button>
          <button type="button" className="secondary" onClick={resetAll} disabled={busy}>Reset all to defaults</button>
        </div>
      </header>
      {error && <p role="alert">{error}</p>}
      {note && <p className="staff-notice" role="status">{note}</p>}
      {hasErrors && <p role="alert">{Object.keys(clientErrors).length} setting{Object.keys(clientErrors).length === 1 ? " needs" : "s need"} fixing before you can save.</p>}

      <div className="se-grid">
        <div className="se-edit">
          <nav className="se-tabs" aria-label="Sections">
            {SECTIONS.map(x => <button key={x.id} type="button" className={x.id === section ? "se-tab on" : "se-tab"} aria-current={x.id === section} onClick={() => setSection(x.id)}>{x.label}</button>)}
          </nav>

          {section === "brand" && (
            <section className="panel" aria-labelledby="h-brand">
              <div className="se-sec-head"><h2 id="h-brand">Brand</h2><button type="button" className="secondary" onClick={() => resetSection(["brand"])}>Reset section</button></div>
              {Text({ label: "Site name", path: "brand.siteName", max: LIMITS.siteName, nullable: true, hint: "Leave empty to use the server default." })}
              {Text({ label: "Tagline", path: "brand.tagline", max: LIMITS.tagline, nullable: true, hint: "Leave empty to use the server default." })}
              <p className="muted">Images: PNG, JPEG or WebP up to 512 KB (favicon may also be ICO). SVG is not accepted. The home hero photo may be up to 1.5 MB, landscape, at least 1200 pixels wide (about 2400 by 1200 is ideal); camera and location data are removed on upload. Use only a photo you own or are licensed to use.</p>
              {SLOTS.map(slot => {
                const t = thumbFor(slot);
                return (
                  <div className="se-field se-upload" key={slot[0]}>
                    <span>{slot[2]}</span>
                    <div className="se-upload-row">
                      <span className={`se-thumb ${slot[0] === "logo-dark" ? "dark" : ""}`}>{t ? <img src={t} alt="" /> : <em className="muted">none</em>}</span>
                      <label className="button secondary se-file">Choose file<input type="file" accept="image/png,image/jpeg,image/webp,image/x-icon,.ico" onChange={e => { void upload(slot, e.target.files?.[0]); e.target.value = ""; }} /></label>
                      {s.brand[slot[1]] !== null && <button type="button" className="secondary" onClick={() => { set(`brand.${slot[1]}`, null); setThumbs(x => ({ ...x, [slot[0]]: "" })); }}>Remove</button>}
                    </div>{err(`brand.${slot[1]}`)}
                  </div>
                );
              })}
            </section>
          )}

          {section === "colours" && (
            <section className="panel" aria-labelledby="h-col">
              <div className="se-sec-head"><h2 id="h-col">Colours</h2><button type="button" className="secondary" onClick={() => resetSection([`colours.${mode}`])}>Reset {mode} colours</button></div>
              <div className="se-seg" role="group" aria-label="Colour mode">
                {(["light", "dark"] as const).map(m => <button key={m} type="button" className={m === mode ? "se-tab on" : "se-tab"} aria-pressed={m === mode} onClick={() => { setMode(m); setPreviewMode(m); }}>{m === "light" ? "Light mode" : "Dark mode"}</button>)}
              </div>
              <p className="muted">Text colours must reach WCAG AA contrast (4.5:1; 3:1 for the primary and accent colours on the page background). Anything lower is refused.</p>
              <div className="se-swatches">
                {swatch("text", "bg", "Text on page")}{swatch("muted", "surface", "Muted on surface")}{swatch("link", "bg", "Link")}
                {swatch("headerText", "headerBg", "Header")}{swatch("buttonText", "buttonBg", "Button")}
              </div>
              <div className="se-cols">{COLOUR_KEYS.map(k => <div key={k} className="se-cell">{ColourField({ k })}</div>)}</div>
            </section>
          )}

          {section === "typography" && (
            <section className="panel" aria-labelledby="h-typ">
              <div className="se-sec-head"><h2 id="h-typ">Typography</h2><button type="button" className="secondary" onClick={() => resetSection(["typography"])}>Reset section</button></div>
              {Choice({ label: "Text font", path: "typography.bodyFont", options: view.options.fonts })}
              {Choice({ label: "Heading font", path: "typography.headingFont", options: view.options.fonts })}
              <p className="muted">Fonts marked “web font” load from Google Fonts only while selected; the rest use fonts already on the visitor’s device.</p>
              {Num({ label: "Base font size", path: "typography.baseSize", range: RANGES.baseSize })}
              {Num({ label: "Heading scale", path: "typography.headingScale", range: RANGES.headingScale, step: 0.05, unit: "×" })}
            </section>
          )}

          {section === "layout" && (
            <section className="panel" aria-labelledby="h-lay">
              <div className="se-sec-head"><h2 id="h-lay">Layout</h2><button type="button" className="secondary" onClick={() => resetSection(["layout"])}>Reset section</button></div>
              {Choice({ label: "Spacing density", path: "layout.density", options: DENSITIES })}
              {Num({ label: "Corner radius", path: "layout.radius", range: RANGES.radius })}
              {Num({ label: "Header height", path: "layout.headerHeight", range: RANGES.headerHeight })}
              {Num({ label: "Logo height", path: "layout.logoHeight", range: RANGES.logoHeight })}
              {Choice({ label: "Button size", path: "layout.buttonSize", options: BUTTON_SIZES })}
              {Choice({ label: "Icon style", path: "layout.iconStyle", options: ICON_STYLES })}
              {Num({ label: "Hero photo overlay strength", path: "layout.heroOverlay", range: RANGES.heroOverlay, unit: "%" })}
              {Num({ label: "Hero photo crop point on phones (left to right)", path: "layout.heroFocus", range: RANGES.heroFocus, unit: "%" })}
              <p className="muted">The overlay darkens the home hero photo so the white heading stays readable. It cannot go below 45%.</p>
            </section>
          )}

          {section === "navigation" && (
            <section className="panel" aria-labelledby="h-nav">
              <div className="se-sec-head"><h2 id="h-nav">Navigation</h2><button type="button" className="secondary" onClick={() => resetSection(["navigation"])}>Reset section</button></div>
              <p className="muted">Reorder, rename or hide links. Each link still only appears to the people it applies to (for example “Staff” only for staff). Hiding a link does not block the page.</p>
              <ul className="se-list">
                {s.navigation.map((it: NavItem, i: number) => (
                  <li key={it.id}>
                    <label className="check"><input type="checkbox" checked={it.visible} onChange={e => set(`navigation.${i}.visible`, e.target.checked)} /><span className="se-sr">Show {it.id}</span></label>
                    <input aria-label={`Label for ${it.id}`} value={it.label} maxLength={LIMITS.navLabel} onChange={e => set(`navigation.${i}.label`, e.target.value)} aria-invalid={!!errors[`navigation.${i}.label`]} />
                    <span className="se-move">
                      <button type="button" className="secondary" aria-label={`Move ${it.label} up`} disabled={i === 0} onClick={() => moveNav(i, -1)}>↑</button>
                      <button type="button" className="secondary" aria-label={`Move ${it.label} down`} disabled={i === s.navigation.length - 1} onClick={() => moveNav(i, 1)}>↓</button>
                    </span>
                    {err(`navigation.${i}.label`)}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {section === "footer" && (
            <section className="panel" aria-labelledby="h-foot">
              <div className="se-sec-head"><h2 id="h-foot">Footer</h2><button type="button" className="secondary" onClick={() => resetSection(["footer"])}>Reset section</button></div>
              {Text({ label: "Footer text", path: "footer.text", max: LIMITS.footerText, hint: "Plain text. Leave empty (and no links) for no footer." })}
              <h3>Links</h3>
              <ul className="se-list">
                {s.footer.links.map((l, i) => (
                  <li key={i} className="se-link-row">
                    <input aria-label={`Link ${i + 1} label`} placeholder="Label" value={l.label} maxLength={LIMITS.footerLinkLabel} onChange={e => set(`footer.links.${i}.label`, e.target.value)} />
                    <input aria-label={`Link ${i + 1} address`} placeholder="https://… or /path" value={l.href} maxLength={LIMITS.urlLength} onChange={e => set(`footer.links.${i}.href`, e.target.value)} />
                    <button type="button" className="secondary" onClick={() => set("footer.links", s.footer.links.filter((_, j) => j !== i))}>Remove</button>
                    {err(`footer.links.${i}.label`)}{err(`footer.links.${i}.href`)}
                  </li>
                ))}
              </ul>
              {err("footer.links")}
              <button type="button" className="secondary" disabled={s.footer.links.length >= LIMITS.footerLinks} onClick={() => set("footer.links", [...s.footer.links, { label: "", href: "/" }])}>Add link</button>
            </section>
          )}

          {section === "history" && (
            <section className="panel" aria-labelledby="h-hist">
              <h2 id="h-hist">Version history</h2>
              <p className="muted">Every save is a new version and nothing is ever overwritten. “Revert” copies a version into a new one and makes it live at once.</p>
              {view.versions.length === 0 ? <p className="empty">No versions yet. The site uses the built-in defaults.</p> : (
                <div className="table-wrap"><table>
                  <thead><tr><th>Version</th><th>Saved by</th><th>When</th><th>Status</th><th><span className="se-sr">Action</span></th></tr></thead>
                  <tbody>{view.versions.map(v => (
                    <tr key={v.version}>
                      <td>{v.version}{v.source !== "save" && <small className="muted"> · {v.source}{v.revertedFrom ? ` of ${v.revertedFrom}` : ""}</small>}</td>
                      <td>{v.createdBy}</td>
                      <td>{new Date(v.createdAt).toLocaleString()}{v.publishedAt && <small className="muted"><br />published {new Date(v.publishedAt).toLocaleString()} by {v.publishedBy}</small>}</td>
                      <td>{v.live && <span className="se-badge live">Live</span>}{v.draft && <span className="se-badge">Draft</span>}</td>
                      <td>{!v.live && <button type="button" className="secondary" disabled={busy} onClick={() => revert(v.version)}>Revert to this</button>}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
              )}
            </section>
          )}
        </div>

        <aside className="se-preview" aria-label="Live preview">
          <div className="se-pbar">
            <strong>Preview</strong>
            <div className="se-seg" role="group" aria-label="Preview mode">
              {(["system", "light", "dark"] as const).map(m => <button key={m} type="button" className={m === previewMode ? "se-tab on" : "se-tab"} aria-pressed={m === previewMode} onClick={() => setPreviewMode(m)}>{m}</button>)}
            </div>
            <div className="se-seg" role="group" aria-label="Preview width">
              {(["desktop", "mobile"] as const).map(m => <button key={m} type="button" className={m === width ? "se-tab on" : "se-tab"} aria-pressed={m === width} onClick={() => setWidth(m)}>{m}</button>)}
            </div>
            <button type="button" className="secondary" onClick={() => { void refreshPreview(); setFrameKey(k => k + 1); }}>Reload</button>
          </div>
          {previewError ? <p className="empty" role="alert">{previewError}</p> : preview ? (
            <div className="se-frame-wrap">
              <iframe key={frameKey} ref={frame} title="Public site preview of the draft" src={preview.url} style={{ width: framePx ?? "100%" }} onLoad={post} referrerPolicy="no-referrer" />
            </div>
          ) : <p className="muted">Loading preview…</p>}
          <small className="muted">Colours, fonts, sizes and spacing update as you edit. Save the draft and press Reload to see text, navigation and image changes.</small>
        </aside>
      </div>
    </main>
  );
}
