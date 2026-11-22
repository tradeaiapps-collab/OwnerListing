"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { APP_STATUS, CATEGORIES, JSON_HEADERS, REPAIR_STATUS, URGENCY, categoryLabel, readError, when } from "./shared";

type Msg = { id: string; kind: string; body: string; at: string };
type Slot = { id: string; startsAt: string; capacity: number; booked: number };
type App = { id: string; listingId: string; address: string; status: string; evaluationMissing: string[]; viewing?: { startsAt: string }; offers: Slot[]; messages: Msg[] };
type Repair = { id: string; ref: string; address: string; category: string; description: string; urgency: string; status: string; createdAt: string; photoIds: string[]; visitAt?: string; needsConsent: boolean; messages: Msg[] };
type Data = { applications: App[]; tenancies: { id: string; listingId: string; address: string }[]; repairs: Repair[] };
const MISSING: Record<string, string> = { income: "weekly household income", history: "rental history", references: "references", move_in: "move-in date" };

/** A renter's page: applications with the viewing times Elena is offering, and, for a current tenant, repair requests Elena sorts and chases. */
export default function MyRentals() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/rentals");
      if (r.ok) { setData(await r.json()); setError(""); } else setError(r.status === 401 ? "Sign in to see your rentals." : await readError(r, "Could not load your rentals."));
    } catch { setError("Could not load your rentals. Check your connection and try again."); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function post(url: string, body: unknown, key: string, ok = "") {
    setBusy(key); setNotice(""); setError("");
    try {
      const r = await fetch(url, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
      if (!r.ok) setError(await readError(r, "That did not work.")); else if (ok) setNotice(ok);
      await load();
    } catch { setError("That did not work. Try again."); } finally { setBusy(""); }
  }

  async function report(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy("report"); setNotice(""); setError("");
    try {
      const r = await fetch("/api/rental-repairs", { method: "POST", body: new FormData(form) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        setNotice(`${d.ref} received. Elena rated it ${String(d.urgency)}: ${String(d.reason)}${d.advice ? ` ${String(d.advice)}` : ""}`);
        form.reset();
      } else setError(d.error ?? "Could not send your repair request.");
      await load();
    } catch { setError("Could not send your repair request. Try again."); } finally { setBusy(""); }
  }

  if (!data) return <main className="rn-page"><h1>My rentals</h1>{error ? <p className="rn-alert" role="alert">{error}</p> : <p className="muted" role="status">Loading…</p>}</main>;
  return (
    <main className="rn-page">
      <header className="rn-head"><h1>My rentals</h1><p className="muted">Your applications, viewing times and repair requests.</p></header>
      {error && <p className="rn-alert" role="alert">{error}</p>}
      {notice && <p className="rn-ok" role="status">{notice}</p>}

      <section className="rn-panel" aria-labelledby="rn-apps">
        <h2 id="rn-apps">Applications</h2>
        {data.applications.length === 0 ? <p className="muted">You have not applied for a rental yet. Open a rental listing and choose Apply to rent.</p> : (
          <ul className="rn-list">
            {data.applications.map(a => (
              <li key={a.id} className="rn-item">
                <div className="rn-top"><strong>{a.address}</strong><span className={`rn-pill st-${a.status}`}>{APP_STATUS[a.status] ?? a.status}</span></div>
                {a.evaluationMissing.length > 0 && ["submitted", "info_requested"].includes(a.status) && (
                  <p className="rn-hint">Elena needs: {a.evaluationMissing.map(m => MISSING[m] ?? m).join(", ")}. <a href={`/listings/${a.listingId}/apply`}>Update your application</a>. Leaving one blank is fine.</p>
                )}
                {a.viewing && (
                  <p>Viewing booked: <strong>{when(a.viewing.startsAt)}</strong>{" "}
                    <button type="button" className="secondary" disabled={busy === `c${a.id}`} onClick={() => void post(`/api/rental-applications/${a.id}`, { action: "cancel_viewing" }, `c${a.id}`, "Viewing cancelled.")}>Cancel viewing</button></p>
                )}
                {!["declined", "withdrawn"].includes(a.status) && (
                  a.offers.length === 0 ? (!a.viewing && <p className="muted">No viewing times yet. Elena will message you when the owner adds some.</p>) : (
                    <div><p className="rn-label">{a.viewing ? "Change your viewing time" : "Pick a viewing time"}</p>
                      <div className="rn-slots">{a.offers.map(s => (
                        <button key={s.id} type="button" className="secondary" disabled={busy === s.id} onClick={() => void post(`/api/rental-applications/${a.id}`, { action: "book", slotId: s.id }, s.id, "Viewing booked. Elena sent you a confirmation.")}>{when(s.startsAt)}</button>
                      ))}</div></div>
                  )
                )}
                {["submitted", "info_requested", "shortlisted"].includes(a.status) && <p><button type="button" className="secondary" disabled={busy === `w${a.id}`} onClick={() => void post(`/api/rental-applications/${a.id}`, { action: "withdraw" }, `w${a.id}`, "Application withdrawn.")}>Withdraw application</button></p>}
                {a.messages.length > 0 && <Log items={a.messages} />}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rn-panel" aria-labelledby="rn-rep">
        <h2 id="rn-rep">Repairs</h2>
        {data.tenancies.length === 0 ? <p className="muted">When an owner adds you as a tenant, you can report repairs here and Elena will sort and chase them.</p> : (
          <form className="rn-form" onSubmit={e => void report(e)}>
            <p className="rn-danger"><strong>If anyone is in danger or there is fire or a gas smell, leave and call 000 first.</strong></p>
            {data.tenancies.length > 1 ? <label>Which home<select name="tenancyId" required>{data.tenancies.map(t => <option key={t.id} value={t.id}>{t.address}</option>)}</select></label>
              : <><input type="hidden" name="tenancyId" value={data.tenancies[0]!.id} /><p className="muted">{data.tenancies[0]!.address}</p></>}
            <label>What kind of problem<select name="category" defaultValue="plumbing">{CATEGORIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
            <label>What is wrong<textarea name="description" rows={3} minLength={10} maxLength={1000} required placeholder="For example: the bathroom tap drips all day." /></label>
            <p className="rn-hint">The owner and any contractor asked to help will read this. Describe the problem only: leave out names, door codes and phone numbers. Photos are shown to a contractor only after they accept the job.</p>
            <label>Photos (up to 3, 2 MB each)<input name="photo" type="file" accept="image/jpeg,image/png,image/webp" multiple /></label>
            <label className="rn-check"><input type="checkbox" name="urgent" value="true" /> This is urgent (no hot water, no power, a leak)</label>
            <label className="rn-check"><input type="checkbox" name="emergency" value="true" /> This is an emergency (a safety risk)</label>
            <button type="submit" disabled={busy === "report"}>{busy === "report" ? "Sending…" : "Send repair request"}</button>
          </form>
        )}
        {data.repairs.length > 0 && (
          <ul className="rn-list">
            {data.repairs.map(r => (
              <li key={r.id} className="rn-item">
                <div className="rn-top"><strong>{r.ref} · {categoryLabel(r.category)}</strong><span className={`rn-pill ug-${r.urgency}`}>{URGENCY[r.urgency] ?? r.urgency}</span></div>
                <p className="rn-wrap">{r.description}</p>
                <p className="muted">{r.address} · {REPAIR_STATUS[r.status] ?? r.status}{r.visitAt ? ` · visit ${when(r.visitAt)}` : ""}</p>
                {r.photoIds.length > 0 && <div className="rn-photos">{r.photoIds.map(p => <a key={p} href={`/api/rental-repairs/${r.id}/photos/${p}`} target="_blank" rel="noreferrer"><img src={`/api/rental-repairs/${r.id}/photos/${p}`} alt={`Photo of the problem, ${r.ref}`} loading="lazy" /></a>)}</div>}
                {r.needsConsent && <div className="rn-ask"><p>A contractor can visit {r.visitAt ? when(r.visitAt) : "soon"}, which is under 24 hours away. Nobody will enter unless you agree.</p>
                  <button type="button" disabled={busy === `v${r.id}`} onClick={() => void post(`/api/rental-repairs/${r.id}`, { action: "consent_visit" }, `v${r.id}`, "Thanks. The visit is confirmed.")}>That time is fine</button></div>}
                {r.status === "check_in" && <div className="rn-actions">
                  <button type="button" disabled={busy === `f${r.id}`} onClick={() => void post(`/api/rental-repairs/${r.id}`, { action: "fixed" }, `f${r.id}`, "Great, it is closed.")}>It is fixed</button>
                  <button type="button" className="secondary" disabled={busy === `n${r.id}`} onClick={() => void post(`/api/rental-repairs/${r.id}`, { action: "not_fixed" }, `n${r.id}`, "Elena has reopened it for the owner.")}>Not fixed</button></div>}
                {r.status !== "closed" && r.status !== "check_in" && <p><button type="button" className="secondary" disabled={busy === `x${r.id}`} onClick={() => void post(`/api/rental-repairs/${r.id}`, { action: "cancel" }, `x${r.id}`, "Request closed.")}>Close this request</button></p>}
                {r.messages.length > 0 && <Log items={r.messages} />}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function Log({ items }: { items: Msg[] }) {
  return (
    <details className="rn-log"><summary>What Elena sent you ({items.length})</summary>
      <ul>{items.map(m => <li key={m.id}><span className="muted">{when(m.at)}</span> {m.body}</li>)}</ul></details>
  );
}
