"use client";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useParams } from "next/navigation";
import "../../styles/agent-marketplace.css";
import "../../styles/contractors.css";
import { Avatar, JSON_HEADERS, Stars, StatGrid, conNo, price, tradeName, type Stats } from "../ui";

type Service = { id: string; kind: string; name: string; description: string; priceCents: number; priceType: string };
type Profile = {
  contractorNo: number; name: string; headline: string; about: string; tradeLabel: string;
  licence: { number: string; state: string; verified: boolean } | null;
  services: Service[]; media: { mediaType: string; url: string; caption: string }[];
  areas: { kind: string; acceptingNew: boolean; suburbs: string[]; postcodes: string[] }[];
  stats: Stats; reviews: { rating: number; body: string; at: string; by: string }[];
};
type Listing = { id: string; title: string };

export default function ContractorProfilePage() {
  const { no } = useParams<{ no: string }>();
  const [p, setP] = useState<Profile | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "missing" | "error">("loading");
  const [listings, setListings] = useState<Listing[]>([]);
  const [signedIn, setSignedIn] = useState(false);
  const [f, setF] = useState({ listingId: "", kind: "", serviceId: "", when: "", note: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; href?: string } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch(`/api/contractors/${no}`);
        if (r.status === 404) { setState("missing"); return; }
        if (!r.ok) throw new Error();
        const d = await r.json();
        setP(d.profile); setState("ok");
        setF(x => ({ ...x, kind: d.profile.areas.find((a: { acceptingNew: boolean }) => a.acceptingNew)?.kind ?? d.profile.areas[0]?.kind ?? "" }));
      } catch { setState("error"); }
      try {
        const m = await fetch("/api/listings/mine");
        if (m.ok) { setSignedIn(true); const l = (await m.json()).listings as Listing[]; setListings(l); setF(x => ({ ...x, listingId: l[0]?.id ?? "" })); }
        else setSignedIn(m.status !== 401);
      } catch { /* the page still reads fine without booking */ }
    })();
  }, [no]);

  const services = useMemo(() => (p?.services ?? []).filter(s => s.kind === f.kind), [p, f.kind]);

  async function book(e: FormEvent) {
    e.preventDefault();
    if (!p) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`/api/listings/${f.listingId}/jobs`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ kind: f.kind, contractorNo: p.contractorNo, ...(f.serviceId ? { serviceId: f.serviceId } : {}), ...(f.when ? { requestedTime: new Date(f.when).toISOString() } : {}), ...(f.note.trim() ? { note: f.note.trim() } : {}) }) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) setMsg({ ok: true, text: `Offer sent as JOB-${d.job.jobNumber}. ${p.name} can accept, reject or suggest another time.`, href: `/jobs/${d.job.id}` });
      else setMsg({ ok: false, text: d.error ?? "Could not send the offer." });
    } catch { setMsg({ ok: false, text: "Could not send the offer." }); } finally { setBusy(false); }
  }

  if (state === "loading") return <main className="ma cm"><p className="ma-state" role="status">Loading…</p></main>;
  if (state === "missing") return <main className="ma cm"><p className="ma-state">This contractor page is not available. <a href="/contractors">Find a contractor</a></p></main>;
  if (state === "error" || !p) return <main className="ma cm"><p className="ma-state ma-error" role="alert">Could not load this page. <a href="/contractors">Back to contractors</a></p></main>;

  const kinds = [...new Set([...p.areas.map(a => a.kind), ...p.services.map(s => s.kind)])];
  return (
    <main className="ma cm">
      <a href="/contractors" className="muted">← All contractors</a>
      <header className="ma-profile-head">
        <div className="ma-head">
          <Avatar name={p.name} photoUrl={null} large />
          <div>
            <span className="cm-num">{conNo(p.contractorNo)}</span>
            <h1>{p.name}</h1>
            {p.headline && <p className="ma-headline">{p.headline}</p>}
          </div>
        </div>
        <ul className="ma-tags" aria-label="Trades">{kinds.map(k => <li key={k} className="ma-tag">{tradeName(k, p.tradeLabel)}</li>)}</ul>
        <div className="ma-meta">
          <Stars value={p.stats.ratingAvg} count={p.stats.ratingCount} />
          {p.licence?.verified ? <span className="cm-badge">✓ Licence verified</span> : p.licence ? <span className="cm-badge muted">Licence on file, not yet checked</span> : null}
        </div>
      </header>

      <section className="ma-section" aria-labelledby="cm-stats"><h2 id="cm-stats">Track record</h2><StatGrid s={p.stats} /></section>
      {p.about && <section className="ma-section" aria-labelledby="cm-about"><h2 id="cm-about">About {p.name}</h2><p style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{p.about}</p></section>}

      <section className="ma-section" aria-labelledby="cm-svc">
        <h2 id="cm-svc">Services and prices</h2>
        {p.services.length === 0 ? <p className="muted" style={{ margin: 0 }}>No prices listed yet. Send an offer and ask.</p> : (
          <ul className="cm-services">{p.services.map(s => <li key={s.id}><span><strong>{s.name}</strong> <span className="muted">· {tradeName(s.kind, p.tradeLabel)}</span></span><span className="price">{price(s.priceCents, s.priceType)}</span>{s.description && <p>{s.description}</p>}</li>)}</ul>
        )}
        <p className="cm-note">You pay the contractor directly. The site does not take payment for jobs.</p>
      </section>

      {p.media.length > 0 && (
        <section className="ma-section" aria-labelledby="cm-gal"><h2 id="cm-gal">Photos and videos</h2>
          <ul className="cm-gallery">{p.media.map((m, i) => <li key={i}><figure>
            {m.mediaType === "photo" ? <img src={m.url} alt={m.caption || `Photo ${i + 1} from ${p.name}`} loading="lazy" referrerPolicy="no-referrer" /> : <a className="video" href={m.url} target="_blank" rel="noopener noreferrer">▶ Watch video</a>}
            {m.caption && <figcaption>{m.caption}</figcaption>}
          </figure></li>)}</ul>
        </section>
      )}

      <section className="ma-section" aria-labelledby="cm-area"><h2 id="cm-area">Where they work</h2>
        {p.areas.length === 0 ? <p className="muted" style={{ margin: 0 }}>No service areas listed.</p> : p.areas.map(a => (
          <p key={a.kind} style={{ margin: 0 }}><strong>{tradeName(a.kind, p.tradeLabel)}</strong>{a.acceptingNew ? "" : " (not taking new jobs)"}: {[...a.suburbs, ...a.postcodes].join(", ") || "Not set"}</p>
        ))}
      </section>

      <section className="ma-section" aria-labelledby="cm-rev"><h2 id="cm-rev">Feedback from owners</h2>
        {p.reviews.length === 0 ? <p className="muted" style={{ margin: 0 }}>No feedback yet. Owners can rate a contractor after a completed job.</p> : (
          <ul className="ma-reviews">{p.reviews.map((r, i) => <li key={i}><Stars value={r.rating} />{r.body && <p>{r.body}</p>}<span className="muted">{r.by} · {new Intl.DateTimeFormat("en-AU", { dateStyle: "medium" }).format(new Date(r.at))}</span></li>)}</ul>
        )}
      </section>

      <section className="ma-section" aria-labelledby="cm-book">
        <h2 id="cm-book">Book {p.name}</h2>
        {!signedIn ? <p style={{ margin: 0 }}><a href={`/login?next=/contractors/${p.contractorNo}`}>Sign in as an owner</a> to send a job offer.</p>
          : listings.length === 0 ? <p className="muted" style={{ margin: 0 }}>Create a listing first, then come back to book.</p> : (
          <form className="cm-book" onSubmit={e => void book(e)}>
            <label className="field"><span>Listing</span><select value={f.listingId} onChange={e => setF({ ...f, listingId: e.target.value })} required>{listings.map(l => <option key={l.id} value={l.id}>{l.title}</option>)}</select></label>
            <label className="field"><span>Trade</span><select value={f.kind} onChange={e => setF({ ...f, kind: e.target.value, serviceId: "" })} required>{kinds.map(k => <option key={k} value={k}>{tradeName(k, p.tradeLabel)}</option>)}</select></label>
            {services.length > 0 && <label className="field"><span>Service</span><select value={f.serviceId} onChange={e => setF({ ...f, serviceId: e.target.value })}><option value="">Not sure yet</option>{services.map(s => <option key={s.id} value={s.id}>{s.name} · {price(s.priceCents, s.priceType)}</option>)}</select></label>}
            <label className="field"><span>Preferred time (optional)</span><input type="datetime-local" value={f.when} onChange={e => setF({ ...f, when: e.target.value })} /></label>
            <label className="field"><span>Message (optional)</span><textarea rows={3} maxLength={1000} value={f.note} onChange={e => setF({ ...f, note: e.target.value })} /></label>
            <div className="cm-actions"><button type="submit" disabled={busy || !f.listingId || !f.kind}>{busy ? "Sending…" : "Send job offer"}</button></div>
            {msg && <p role="status" className={msg.ok ? "ma-ok" : "ma-error"}>{msg.text} {msg.href && <a href={msg.href}>Open the job</a>}</p>}
          </form>
        )}
      </section>
    </main>
  );
}
