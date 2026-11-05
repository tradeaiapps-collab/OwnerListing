"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import "../../styles/agent-marketplace.css";
import { Avatar, Stars } from "./ui";

type Card = {
  id: string; name: string; headline: string; photoUrl: string | null; specialties: string[]; languages: string[]; yearsExperience: number | null;
  consultModes: string[]; consultMinutes: number; areas: string[]; acceptingNew: boolean; reviewCount: number; rating: number | null; sales: number;
};
type Result = { agents: Card[]; total: number; page: number; pageSize: number };
const SPECIALTIES = ["first home buyers", "investors", "luxury", "downsizers", "new builds", "rural", "apartments", "commercial", "rentals", "auctions", "negotiation", "development sites"];
const FIELDS = ["q", "area", "specialty", "language", "mode", "minRating", "sort"] as const;

/** Public: browse licensed agents by area, specialty, language, rating and consultation type. */
export default function AgentMarketplacePage() {
  const [f, setF] = useState<Record<string, string>>({ q: "", area: "", specialty: "", language: "", mode: "", minRating: "", sort: "rating" });
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);

  const load = useCallback(async (values: Record<string, string>, p: number) => {
    setBusy(true); setError("");
    const sp = new URLSearchParams();
    for (const k of FIELDS) if (values[k]) sp.set(k, values[k]!);
    if (p > 1) sp.set("page", String(p));
    window.history.replaceState(null, "", sp.size ? `?${sp}` : window.location.pathname);
    try {
      const r = await fetch(`/api/marketplace/agents?${sp}`);
      if (!r.ok) throw new Error();
      setData(await r.json());
    } catch { setError("Could not load agents. Try again."); } finally { setBusy(false); }
  }, []);

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const init = Object.fromEntries(FIELDS.map(k => [k, sp.get(k) ?? (k === "sort" ? "rating" : "")]));
    const p = Math.max(1, Number(sp.get("page") ?? 1) || 1);
    setF(init); setPage(p); void load(init, p);
  }, [load]);

  const set = (k: string) => (e: { target: { value: string } }) => setF(prev => ({ ...prev, [k]: e.target.value }));
  const submit = (e: FormEvent) => { e.preventDefault(); setPage(1); void load(f, 1); };
  const go = (p: number) => { setPage(p); void load(f, p); window.scrollTo({ top: 0 }); };
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <main className="ma">
      <div>
        <h1>Find an agent</h1>
        <p className="muted">Licensed agents on the platform. Compare reviews and recent sales, then book a free consultation by video or phone.</p>
      </div>
      <form className="ma-filters" onSubmit={submit} role="search" aria-label="Filter agents">
        <label className="field">Name or keyword<input value={f["q"]} onChange={set("q")} maxLength={60} placeholder="e.g. Alex" /></label>
        <label className="field">Suburb or postcode<input value={f["area"]} onChange={set("area")} maxLength={60} placeholder="e.g. Bulimba or 4171" /></label>
        <label className="field">Specialty
          <select value={f["specialty"]} onChange={set("specialty")}><option value="">Any</option>{SPECIALTIES.map(s => <option key={s} value={s}>{s}</option>)}</select>
        </label>
        <label className="field">Language<input value={f["language"]} onChange={set("language")} maxLength={30} placeholder="e.g. Mandarin" /></label>
        <label className="field">Consultation
          <select value={f["mode"]} onChange={set("mode")}><option value="">Video or phone</option><option value="video">Video</option><option value="phone">Phone</option></select>
        </label>
        <label className="field">Minimum rating
          <select value={f["minRating"]} onChange={set("minRating")}><option value="">Any</option><option value="3">3 stars and up</option><option value="4">4 stars and up</option><option value="4.5">4.5 stars and up</option></select>
        </label>
        <label className="field">Sort by
          <select value={f["sort"]} onChange={set("sort")}><option value="rating">Highest rated</option><option value="reviews">Most reviews</option><option value="experience">Most experience</option><option value="name">Name</option></select>
        </label>
        <div className="actions"><button type="submit" disabled={busy}>Search</button>
          <button type="button" className="secondary" onClick={() => { const blank = { q: "", area: "", specialty: "", language: "", mode: "", minRating: "", sort: "rating" }; setF(blank); setPage(1); void load(blank, 1); }}>Clear</button></div>
      </form>

      <p aria-live="polite" className="muted">{busy ? "Loading agents…" : data ? `${data.total} ${data.total === 1 ? "agent" : "agents"} found` : ""}</p>
      {error && <p role="alert" className="ma-error">{error}</p>}
      {!busy && data && data.agents.length === 0 && !error && <div className="ma-state"><p>No agents match those filters.</p><p className="muted">Try a wider area or clear a filter.</p></div>}
      {data && data.agents.length > 0 && (
        <ul className="ma-grid">
          {data.agents.map(a => (
            <li key={a.id} className="ma-card">
              <div className="ma-head">
                <Avatar name={a.name} photoUrl={a.photoUrl} />
                <div><h2><a href={`/marketplace/agents/${a.id}`}>{a.name}</a></h2><Stars value={a.rating} count={a.reviewCount} /></div>
              </div>
              {a.headline && <p className="ma-headline">{a.headline}</p>}
              <ul className="ma-meta">
                {a.yearsExperience !== null && <li>{a.yearsExperience} yrs experience</li>}
                {a.sales > 0 && <li>{a.sales} {a.sales === 1 ? "sale" : "sales"}</li>}
                {a.consultModes.length > 0 && <li>{a.consultMinutes} min {a.consultModes.join(" or ")}</li>}
              </ul>
              {a.areas.length > 0 && <p className="muted" style={{ margin: 0 }}>{a.areas.join(", ")}</p>}
              {a.specialties.length > 0 && <ul className="ma-tags">{a.specialties.slice(0, 4).map(s => <li key={s} className="ma-tag">{s}</li>)}</ul>}
              <div className="actions">
                <a className="button" href={`/marketplace/agents/${a.id}`}>View profile</a>
                {a.consultModes.length > 0 && <a className="button secondary" href={`/marketplace/agents/${a.id}?book=1`}>Book a consultation</a>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {data && pages > 1 && (
        <nav className="ma-pager" aria-label="Pages">
          <button type="button" className="secondary" disabled={busy || page <= 1} onClick={() => go(page - 1)}>Previous</button>
          <span>Page {page} of {pages}</span>
          <button type="button" className="secondary" disabled={busy || page >= pages} onClick={() => go(page + 1)}>Next</button>
        </nav>
      )}
    </main>
  );
}
