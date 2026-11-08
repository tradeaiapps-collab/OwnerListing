"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import "../../styles/agent-marketplace.css";
import { JSON_HEADERS, aud, monthLabel } from "../../marketplace/agents/ui";

type Win = { weekday: number; startMin: number; endMin: number };
type Profile = {
  listed: boolean; headline: string; photoUrl: string | null; specialties: string[]; languages: string[]; yearsExperience: number | null; consultModes: string[]; consultMinutes: number;
  videoUrl: string | null; timezone: string; availability: Win[];
};
type Item = { id?: string; suburb: string; propertyType: string; month: string; priceCents?: number; note?: string };
type Own = { profile: Profile; bio: string; portfolio: Item[]; maxPortfolio: number };

const SPECIALTIES = ["first home buyers", "investors", "luxury", "downsizers", "new builds", "rural", "apartments", "commercial", "rentals", "auctions", "negotiation", "development sites"];
const ZONES = ["Australia/Brisbane", "Australia/Sydney", "Australia/Melbourne", "Australia/Hobart", "Australia/Adelaide", "Australia/Darwin", "Australia/Perth"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const toTime = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const fromTime = (t: string) => { const [h, m] = t.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };
const splitList = (s: string) => s.split(/[,\n]/).map(x => x.trim()).filter(Boolean);

/** Agent screen: go public in the marketplace, set weekly hours and consultation types, and keep a portfolio of past sales. */
export default function AgentMarketplaceSettings() {
  const [own, setOwn] = useState<Own | null>(null);
  const [p, setP] = useState<Profile | null>(null);
  const [languages, setLanguages] = useState("");
  const [loadError, setLoadError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [sale, setSale] = useState({ suburb: "", propertyType: "house", soldOn: "", price: "", note: "" });
  const [saleMsg, setSaleMsg] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/agent/marketplace");
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return setLoadError(r.status === 401 ? "Sign in to manage your marketplace profile." : d.error ?? "Could not load your profile.");
      setOwn(d); setP(d.profile); setLanguages(d.profile.languages.join(", "));
    } catch { setLoadError("Could not load your profile."); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const toggle = (key: "specialties" | "consultModes", v: string) => setP(prev => (prev ? { ...prev, [key]: prev[key].includes(v) ? prev[key].filter(x => x !== v) : [...prev[key], v] } : prev));
  const setWin = (i: number, w: Partial<Win>) => setP(prev => (prev ? { ...prev, availability: prev.availability.map((x, j) => (j === i ? { ...x, ...w } : x)) } : prev));

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!p) return;
    setBusy(true); setMsg("");
    try {
      const body = { ...p, languages: splitList(languages), photoUrl: p.photoUrl || null, videoUrl: p.videoUrl || null };
      const r = await fetch("/api/agent/marketplace", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      setMsg(r.ok ? (p.listed ? "Saved. Your profile is public." : "Saved. Your profile is hidden.") : d.error ?? "Could not save.");
      if (r.ok) await load();
    } catch { setMsg("Could not save."); } finally { setBusy(false); }
  }

  async function addSale(e: FormEvent) {
    e.preventDefault();
    setSaleMsg("");
    const dollars = sale.price.trim() === "" ? null : Math.round(Number(sale.price.replace(/[$,\s]/g, "")) * 100);
    if (dollars !== null && !(dollars > 0)) return setSaleMsg("Enter the price as a number, or leave it blank.");
    try {
      const r = await fetch("/api/agent/marketplace/portfolio", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ suburb: sale.suburb, propertyType: sale.propertyType, soldOn: sale.soldOn, priceCents: dollars, note: sale.note }) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { setSale({ suburb: "", propertyType: "house", soldOn: "", price: "", note: "" }); await load(); } else setSaleMsg(d.error ?? "Could not add the sale.");
    } catch { setSaleMsg("Could not add the sale."); }
  }
  async function removeSale(id: string) {
    const r = await fetch(`/api/agent/marketplace/portfolio/${id}`, { method: "DELETE", headers: JSON_HEADERS });
    if (r.ok) await load(); else setSaleMsg("Could not remove the sale.");
  }

  if (loadError) return <main className="ma"><p role="alert" className="ma-error">{loadError}</p></main>;
  if (!own || !p) return <main className="ma"><p className="muted">Loading…</p></main>;
  return (
    <main className="ma">
      <div>
        <h1>Marketplace profile</h1>
        <p className="muted">Buyers find you by area, specialty and rating, then book a free consultation. Your bio and service areas come from your <a href="/agent/profile">agent profile</a>. Your <a href="/marketplace/consultations">consultations</a> are listed separately.</p>
      </div>
      <form className="ma-form" onSubmit={save}>
        <section className="ma-section" aria-labelledby="vis-h">
          <h2 id="vis-h">Visibility</h2>
          <label className="ma-checks"><input type="checkbox" checked={p.listed} onChange={e => setP({ ...p, listed: e.target.checked })} /> List me in the agent marketplace</label>
          <p className="muted" style={{ margin: 0 }}>Needs a verified licence, a headline, and a bio of 20+ characters{own.bio.trim().length < 20 ? " (yours is too short, add it on your agent profile)" : ""}.</p>
          <label className="field">Headline<input value={p.headline} onChange={e => setP({ ...p, headline: e.target.value })} maxLength={120} placeholder="e.g. Inner-city apartments and first home buyers" /></label>
          <div className="ma-row">
            <label className="field">Photo link <span className="hint">https address of a headshot. Optional.</span><input type="url" value={p.photoUrl ?? ""} onChange={e => setP({ ...p, photoUrl: e.target.value })} maxLength={500} /></label>
            <label className="field">Years of experience<input type="number" min={0} max={60} value={p.yearsExperience ?? ""} onChange={e => setP({ ...p, yearsExperience: e.target.value === "" ? null : Number(e.target.value) })} /></label>
          </div>
          <fieldset className="ma-checks"><legend className="muted">Specialties</legend>
            {SPECIALTIES.map(s => <label key={s}><input type="checkbox" checked={p.specialties.includes(s)} onChange={() => toggle("specialties", s)} /> {s}</label>)}
          </fieldset>
          <label className="field">Languages spoken <span className="hint">Comma separated</span><input value={languages} onChange={e => setLanguages(e.target.value)} placeholder="English, Mandarin" /></label>
        </section>

        <section className="ma-section" aria-labelledby="con-h">
          <h2 id="con-h">Consultations</h2>
          <fieldset className="ma-checks"><legend className="muted">Offer</legend>
            {["video", "phone"].map(m => <label key={m}><input type="checkbox" checked={p.consultModes.includes(m)} onChange={() => toggle("consultModes", m)} /> {m} calls</label>)}
          </fieldset>
          <div className="ma-row">
            <label className="field">Length<select value={p.consultMinutes} onChange={e => setP({ ...p, consultMinutes: Number(e.target.value) })}>{[15, 30, 45, 60].map(m => <option key={m} value={m}>{m} minutes</option>)}</select></label>
            <label className="field">Timezone<select value={p.timezone} onChange={e => setP({ ...p, timezone: e.target.value })}>{ZONES.map(z => <option key={z} value={z}>{z.split("/")[1]}</option>)}</select></label>
          </div>
          {p.consultModes.includes("video") && <label className="field">Video meeting link <span className="hint">https address (Zoom, Meet or Teams). Shown only to people who book.</span><input type="url" value={p.videoUrl ?? ""} onChange={e => setP({ ...p, videoUrl: e.target.value })} maxLength={500} /></label>}
          <h3>Weekly hours</h3>
          {p.availability.length === 0 && <p className="muted" style={{ margin: 0 }}>No hours yet. Add a window for each day you take calls.</p>}
          {p.availability.map((w, i) => (
            <div className="ma-window" key={i}>
              <label className="field">Day<select value={w.weekday} onChange={e => setWin(i, { weekday: Number(e.target.value) })}>{DAYS.map((d, n) => <option key={d} value={n}>{d}</option>)}</select></label>
              <label className="field">From<input type="time" step={900} value={toTime(w.startMin)} onChange={e => setWin(i, { startMin: fromTime(e.target.value) })} /></label>
              <label className="field">To<input type="time" step={900} value={toTime(w.endMin === 1440 ? 1439 : w.endMin)} onChange={e => setWin(i, { endMin: fromTime(e.target.value) })} /></label>
              <button type="button" className="secondary" onClick={() => setP({ ...p, availability: p.availability.filter((_, j) => j !== i) })} aria-label={`Remove ${DAYS[w.weekday]} window`}>Remove</button>
            </div>
          ))}
          <div className="actions" style={{ margin: 0 }}><button type="button" className="secondary" disabled={p.availability.length >= 21} onClick={() => setP({ ...p, availability: [...p.availability, { weekday: 1, startMin: 540, endMin: 1020 }] })}>Add hours</button></div>
        </section>
        {msg && <p role="status" className={msg.startsWith("Saved") ? "ma-ok" : "ma-error"}>{msg}</p>}
        <div className="actions" style={{ margin: 0 }}>
          <button type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
          {p.listed && <a className="button secondary" href={`/marketplace/agents`}>View marketplace</a>}
        </div>
      </form>

      <section className="ma-section" aria-labelledby="pf-h">
        <h2 id="pf-h">Portfolio</h2>
        <p className="muted" style={{ margin: 0 }}>Sales made through this platform appear on your profile automatically (suburb and month only, never the price). Add earlier sales here. Prices are optional and shown as you enter them.</p>
        {own.portfolio.length === 0 ? <p className="muted" style={{ margin: 0 }}>No sales added yet.</p> : (
          <ul className="ma-portfolio">
            {own.portfolio.map(i => (
              <li key={i.id}>
                <div><strong>{i.suburb}</strong> <span className="muted" style={{ textTransform: "capitalize" }}>· {i.propertyType}</span>{i.priceCents ? <> · {aud(i.priceCents)}</> : null}{i.note ? <> · {i.note}</> : null}</div>
                <span className="when">{monthLabel(i.month)}</span>
                <p className="src"><button type="button" className="secondary" onClick={() => i.id && removeSale(i.id)} aria-label={`Remove sale in ${i.suburb}`}>Remove</button></p>
              </li>
            ))}
          </ul>
        )}
        <form className="ma-form" onSubmit={addSale}>
          <div className="ma-row">
            <label className="field">Suburb<input value={sale.suburb} onChange={e => setSale({ ...sale, suburb: e.target.value })} required maxLength={80} /></label>
            <label className="field">Property type<input value={sale.propertyType} onChange={e => setSale({ ...sale, propertyType: e.target.value })} maxLength={30} /></label>
            <label className="field">Sold on<input type="date" value={sale.soldOn} max={new Date().toISOString().slice(0, 10)} onChange={e => setSale({ ...sale, soldOn: e.target.value })} required /></label>
            <label className="field">Price (AUD) <span className="hint">Optional</span><input inputMode="numeric" value={sale.price} onChange={e => setSale({ ...sale, price: e.target.value })} placeholder="1,250,000" /></label>
          </div>
          <label className="field">Note <span className="hint">Optional, e.g. “Auction, 4 bidders”</span><input value={sale.note} onChange={e => setSale({ ...sale, note: e.target.value })} maxLength={200} /></label>
          {saleMsg && <p role="alert" className="ma-error">{saleMsg}</p>}
          <div className="actions" style={{ margin: 0 }}><button type="submit" disabled={own.portfolio.length >= own.maxPortfolio}>Add sale</button></div>
        </form>
      </section>
    </main>
  );
}
