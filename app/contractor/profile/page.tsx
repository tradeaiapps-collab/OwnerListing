"use client";
import { useEffect, useState, type FormEvent } from "react";
import "../../styles/agent-marketplace.css";
import "../../styles/contractors.css";
import { JSON_HEADERS } from "../../listings/ui";
import { StatGrid, conNo, tradeName, type Stats } from "../../contractors/ui";

type Trade = "photographer" | "inspector" | "pest_control" | "other";
const TRADES: Trade[] = ["photographer", "inspector", "pest_control", "other"];
type Area = { acceptingNew: boolean; suburbs: string; postcodes: string };
const EMPTY_AREA: Area = { acceptingNew: true, suburbs: "", postcodes: "" };
type Svc = { kind: Trade; name: string; description: string; priceDollars: string; priceType: string };
type Media = { mediaType: string; url: string; caption: string };
type Page = { businessName: string; headline: string; about: string; tradeLabel: string; licenceNumber: string; licenceState: string; isPublic: boolean };
const EMPTY_PAGE: Page = { businessName: "", headline: "", about: "", tradeLabel: "", licenceNumber: "", licenceState: "", isPublic: false };
const STATES = ["", "NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"];

/** The contractor's own page: job figures, the public page (about, priced services, gallery, licence) and where they work. Saving the page never takes payment: owners pay contractors directly. */
export default function ContractorProfile() {
  const [page, setPage] = useState<Page>(EMPTY_PAGE);
  const [no, setNo] = useState<number | null>(null);
  const [verified, setVerified] = useState(false);
  const [svcs, setSvcs] = useState<Svc[]>([]);
  const [media, setMedia] = useState<Media[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [areas, setAreas] = useState<Record<Trade, Area>>({ photographer: EMPTY_AREA, inspector: EMPTY_AREA, pest_control: EMPTY_AREA, other: EMPTY_AREA });
  const [msg, setMsg] = useState("");
  const [areaMsg, setAreaMsg] = useState<Partial<Record<Trade, string>>>({});
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const [a, b] = await Promise.all([fetch("/api/contractor-page"), fetch("/api/contractor-profile")]);
        if (a.status === 401) { setError("Sign in to edit your contractor page."); return; }
        const d = await a.json(), pr = await b.json();
        if (d.page) { const { contractorNo, licenceVerified, ...rest } = d.page; setPage(rest); setNo(contractorNo); setVerified(licenceVerified); }
        setSvcs(d.services.map((s: { kind: Trade; name: string; description: string; priceCents: number; priceType: string }) => ({ kind: s.kind, name: s.name, description: s.description, priceDollars: String(s.priceCents / 100), priceType: s.priceType })));
        setMedia(d.media.map((m: Media) => ({ mediaType: m.mediaType, url: m.url, caption: m.caption })));
        setStats(d.stats);
        const conv = (p: { acceptingNew: boolean; serviceSuburbs: string[]; servicePostcodes: string[] } | null): Area => (p ? { acceptingNew: p.acceptingNew, suburbs: p.serviceSuburbs.join(", "), postcodes: p.servicePostcodes.join(", ") } : EMPTY_AREA);
        setAreas({ photographer: conv(pr.profiles.photographer), inspector: conv(pr.profiles.inspector), pest_control: conv(pr.profiles.pest_control), other: conv(pr.profiles.other) });
        setLoaded(true);
      } catch { setError("Could not load your page."); }
    })();
  }, []);

  async function savePage(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(""); setError("");
    try {
      const body = { ...page, services: svcs.map(s => ({ kind: s.kind, name: s.name, description: s.description, priceDollars: Number(s.priceDollars), priceType: s.priceType })), media };
      const r = await fetch("/api/contractor-page", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { setNo(d.contractorNo); setMsg(page.isPublic ? "Saved. Your page is public." : "Saved. Your page is hidden until you tick Show my page publicly."); } else setError(d.error ?? "Could not save.");
    } catch { setError("Could not save."); } finally { setBusy(false); }
  }
  async function saveArea(kind: Trade) {
    const f = areas[kind], split = (s: string) => s.split(/[,\n]/).map(x => x.trim()).filter(Boolean);
    setAreaMsg(m => ({ ...m, [kind]: "" })); setError("");
    const r = await fetch("/api/contractor-profile", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ kind, acceptingNew: f.acceptingNew, serviceSuburbs: split(f.suburbs), servicePostcodes: split(f.postcodes) }) });
    const d = await r.json().catch(() => ({}));
    if (r.ok) setAreaMsg(m => ({ ...m, [kind]: "Saved." })); else setError(d.error ?? "Could not save.");
  }
  const upd = <T,>(list: T[], i: number, patch: Partial<T>) => list.map((x, j) => (j === i ? { ...x, ...patch } : x));

  return (
    <main className="ma cm">
      <header>
        <h1>Your contractor page</h1>
        <p className="muted" style={{ margin: 0 }}>{no !== null && <><span className="cm-num">{conNo(no)}</span> · </>}{page.isPublic && no !== null ? <a href={`/contractors/${no}`}>View your public page</a> : "Owners can find you once your page is public."} · <a href="/contractor/jobs">Your jobs</a> · <a href="/contractor/trust">Verification and reviews</a> · <a href="/contractor/emergency">Emergency call-outs</a></p>
      </header>
      {error && <p className="ma-state ma-error" role="alert">{error}</p>}
      {!loaded && !error && <p className="ma-state" role="status">Loading…</p>}

      {loaded && stats && <section className="ma-section" aria-labelledby="cm-me"><h2 id="cm-me">Your job figures</h2><StatGrid s={stats} own /></section>}

      {loaded && (
        <form className="cm" onSubmit={e => void savePage(e)}>
          <section className="ma-section" aria-labelledby="cm-pub">
            <h2 id="cm-pub">About you</h2>
            <label className="field"><span>Business or trading name</span><input value={page.businessName} maxLength={100} onChange={e => setPage({ ...page, businessName: e.target.value })} /></label>
            <label className="field"><span>Headline</span><input value={page.headline} maxLength={140} onChange={e => setPage({ ...page, headline: e.target.value })} /></label>
            <label className="field"><span>About you and your work</span><textarea rows={6} value={page.about} maxLength={3000} onChange={e => setPage({ ...page, about: e.target.value })} /></label>
            <label className="field"><span>Trade name, if you chose Other (for example Cleaner)</span><input value={page.tradeLabel} maxLength={60} onChange={e => setPage({ ...page, tradeLabel: e.target.value })} /></label>
            <label className="field"><span>Licence number (optional)</span><input value={page.licenceNumber} maxLength={40} onChange={e => setPage({ ...page, licenceNumber: e.target.value })} /></label>
            <label className="field"><span>Licence state</span><select value={page.licenceState} onChange={e => setPage({ ...page, licenceState: e.target.value })}>{STATES.map(s => <option key={s} value={s}>{s || "None"}</option>)}</select></label>
            <p className="cm-note">{verified ? "Your licence is verified. Changing the number or state means it is checked again." : "The Licence verified badge shows after our team checks your licence."}</p>
          </section>

          <section className="ma-section" aria-labelledby="cm-svc">
            <h2 id="cm-svc">Services and your prices</h2>
            <p className="cm-note">Owners see exactly these prices and pay you directly. We do not take payment.</p>
            <ul className="cm-rows">{svcs.map((s, i) => (
              <li key={i} className="cm-row">
                <label className="field"><span>Trade</span><select value={s.kind} onChange={e => setSvcs(upd(svcs, i, { kind: e.target.value as Trade }))}>{TRADES.map(t => <option key={t} value={t}>{tradeName(t, page.tradeLabel)}</option>)}</select></label>
                <label className="field"><span>Service</span><input value={s.name} maxLength={100} required onChange={e => setSvcs(upd(svcs, i, { name: e.target.value }))} /></label>
                <label className="field"><span>Price (AUD)</span><input inputMode="decimal" value={s.priceDollars} required pattern="[0-9]+(\.[0-9]{1,2})?" onChange={e => setSvcs(upd(svcs, i, { priceDollars: e.target.value }))} /></label>
                <label className="field"><span>Price type</span><select value={s.priceType} onChange={e => setSvcs(upd(svcs, i, { priceType: e.target.value }))}><option value="fixed">Fixed</option><option value="from">From</option><option value="per_hour">Per hour</option></select></label>
                <label className="field wide"><span>Details (optional)</span><input value={s.description} maxLength={500} onChange={e => setSvcs(upd(svcs, i, { description: e.target.value }))} /></label>
                <div className="wide"><button type="button" className="secondary" onClick={() => setSvcs(svcs.filter((_, j) => j !== i))}>Remove service</button></div>
              </li>
            ))}</ul>
            {svcs.length < 40 && <div><button type="button" className="secondary" onClick={() => setSvcs([...svcs, { kind: "photographer", name: "", description: "", priceDollars: "", priceType: "fixed" }])}>Add a service</button></div>}
          </section>

          <section className="ma-section" aria-labelledby="cm-gal">
            <h2 id="cm-gal">Photos and videos of your work</h2>
            <p className="cm-note">Paste a secure (https) link to each photo or video, for example from your website or a video site.</p>
            <ul className="cm-rows">{media.map((m, i) => (
              <li key={i} className="cm-row media">
                <label className="field"><span>Type</span><select value={m.mediaType} onChange={e => setMedia(upd(media, i, { mediaType: e.target.value }))}><option value="photo">Photo</option><option value="video">Video</option></select></label>
                <label className="field"><span>Link</span><input type="url" value={m.url} required placeholder="https://" onChange={e => setMedia(upd(media, i, { url: e.target.value }))} /></label>
                <label className="field"><span>Caption</span><input value={m.caption} maxLength={140} onChange={e => setMedia(upd(media, i, { caption: e.target.value }))} /></label>
                <div className="wide"><button type="button" className="secondary" onClick={() => setMedia(media.filter((_, j) => j !== i))}>Remove</button></div>
              </li>
            ))}</ul>
            {media.length < 30 && <div><button type="button" className="secondary" onClick={() => setMedia([...media, { mediaType: "photo", url: "", caption: "" }])}>Add a photo or video</button></div>}
          </section>

          <section className="ma-section">
            <label className="field"><span><input type="checkbox" checked={page.isPublic} onChange={e => setPage({ ...page, isPublic: e.target.checked })} /> Show my page publicly</span></label>
            <div className="cm-actions"><button type="submit" disabled={busy}>{busy ? "Saving…" : "Save my page"}</button></div>
            {msg && <p role="status" className="ma-ok">{msg}</p>}
          </section>
        </form>
      )}

      {loaded && (
        <section className="ma-section" aria-labelledby="cm-areas">
          <h2 id="cm-areas">Where you work</h2>
          <p className="muted" style={{ margin: 0 }}>Owners search by suburb and postcode, and Elena suggests you for listings there. You always accept or reject each job.</p>
          {TRADES.map(kind => (
            <form key={kind} className="cm-inline" onSubmit={e => { e.preventDefault(); void saveArea(kind); }}>
              <h3>{tradeName(kind, page.tradeLabel)}</h3>
              <label className="field"><span>Suburbs, separated by commas</span><input value={areas[kind].suburbs} onChange={e => setAreas({ ...areas, [kind]: { ...areas[kind], suburbs: e.target.value } })} /></label>
              <label className="field"><span>Postcodes, separated by commas</span><input inputMode="numeric" value={areas[kind].postcodes} onChange={e => setAreas({ ...areas, [kind]: { ...areas[kind], postcodes: e.target.value } })} /></label>
              <label className="field"><span><input type="checkbox" checked={areas[kind].acceptingNew} onChange={e => setAreas({ ...areas, [kind]: { ...areas[kind], acceptingNew: e.target.checked } })} /> Taking new jobs</span></label>
              <div className="cm-actions"><button type="submit" className="secondary">Save {tradeName(kind, page.tradeLabel).toLowerCase()} areas</button>{areaMsg[kind] && <span role="status" className="ma-ok">{areaMsg[kind]}</span>}</div>
            </form>
          ))}
        </section>
      )}
    </main>
  );
}
