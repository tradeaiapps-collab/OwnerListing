"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams } from "next/navigation";
import { APP_STATUS, CRITERION_STATUS, JSON_HEADERS, REPAIR_STATUS, URGENCY, categoryLabel, localToIso, money, readError, when } from "../../../rentals/shared";

type Crit = { key: string; label: string; status: string; reason: string };
type Msg = { id: string; kind: string; body: string; status: string; reason?: string; at: string };
type App = { id: string; applicantName: string; status: string; rank: number; note?: string; noteWithheld: boolean; identityHidden?: boolean; createdAt: string; evaluation: { criteria: Crit[]; headline: string; missing: string[] }; viewing?: { startsAt: string; status: string } };
type Settings = { elenaOn: boolean; maxRentPct: number; minHistoryMonths: number; minReferences: number; moveInFrom?: string; moveInTo?: string; autoRepairOffers: boolean; autoEmergency: boolean };
type Slot = { id: string; startsAt: string; durationMin: number; capacity: number; booked: number; status: string };
type Repair = { id: string; no: number; category: string; description: string; urgency: string; urgencyReason: string; status: string; tenantName: string; proposedContractorName?: string; proposedReasons: string[]; photoIds: string[]; messages: Msg[]; needsOwnerReason?: string; visitAt?: string; createdAt: string };
type Desk = { listing: { id: string; address: string; weeklyRentCents?: number; published: boolean }; settings: Settings; applications: App[]; slots: Slot[]; tenancies: { id: string; tenantName: string; status: string }[]; repairs: Repair[] };

const NOT_USED = "Elena weighs only rent against income, rental history, references and the move-in date. She does not use or infer age, family, religion, race, disability, occupation or any other personal attribute. She never declines anyone: you decide.";

/** The owner's rentals desk: Elena's side-by-side summary of applications, viewing times, tenants and repairs. Elena summarises and flags; the owner decides. */
export default function RentalsDesk() {
  const { id } = useParams<{ id: string }>();
  const [desk, setDesk] = useState<Desk | null>(null);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/listings/${id}/rentals`);
      if (r.ok) { setDesk(await r.json()); setLoadError(""); } else setLoadError(r.status === 401 ? "Sign in to see your rentals desk." : r.status === 404 ? "This rental was not found on your account." : await readError(r, "Could not load your rentals desk."));
    } catch { setLoadError("Could not load your rentals desk. Check your connection and try again."); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  async function call(method: string, url: string, body: unknown, key: string, ok = "") {
    setBusy(key); setError(""); setNotice("");
    try {
      const r = await fetch(url, { method, headers: JSON_HEADERS, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) setError(d.error ?? "That did not work."); else setNotice(d.message ?? ok);
      await load();
      return r.ok;
    } catch { setError("That did not work. Try again."); return false; } finally { setBusy(""); }
  }

  if (!desk) return <main className="rn-page"><h1>Rentals desk</h1>{loadError ? <p className="rn-alert" role="alert">{loadError}</p> : <p className="muted" role="status">Loading…</p>}</main>;
  const approved = desk.applications.filter(a => a.status === "approved");
  return (
    <main className="rn-page rn-wide">
      <header className="rn-head"><h1>Rentals desk</h1><p className="muted">{desk.listing.address}{desk.listing.weeklyRentCents ? ` · ${money(desk.listing.weeklyRentCents)} a week` : ""}{desk.listing.published ? "" : " · not published yet"}</p></header>
      {error && <p className="rn-alert" role="alert">{error}</p>}
      {notice && <p className="rn-ok" role="status">{notice}</p>}
      <SettingsPanel s={desk.settings} busy={busy === "settings"} onSave={async s => { await call("PUT", `/api/listings/${id}/rentals`, s, "settings", "Saved."); }} />

      <section className="rn-panel" aria-labelledby="rn-apps">
        <h2 id="rn-apps">Applications</h2>
        <p className="rn-hint">{NOT_USED}</p>
        {desk.applications.length === 0 ? <p className="muted">No applications yet. When someone applies, Elena compares them here against your criteria.</p> : (
          <>
            <div className="rn-table" role="region" aria-label="Applications compared side by side" tabIndex={0}>
              <table>
                <thead><tr><th scope="col" className="c-rank">#</th><th scope="col" className="c-name">Applicant</th><th scope="col">Rent against income</th><th scope="col">Rental history</th><th scope="col">References</th><th scope="col">Move-in</th><th scope="col" className="c-view">Viewing</th><th scope="col" className="c-act">Decision</th></tr></thead>
                <tbody>{desk.applications.map(a => (
                  <tr key={a.id}>
                    <td className="c-rank">{a.rank}</td>
                    <th scope="row" className="c-name"><span className="rn-name">{a.applicantName}</span><span className={`rn-pill st-${a.status}`}>{APP_STATUS[a.status] ?? a.status}</span></th>
                    {["income", "history", "references", "move_in"].map(k => <td key={k}><Cell c={a.evaluation.criteria.find(c => c.key === k)} /></td>)}
                    <td className="c-view">{a.viewing ? when(a.viewing.startsAt) : <span className="muted">None booked</span>}</td>
                    <td className="c-act"><Decide a={a} busy={busy} onAct={(action, ok) => call("POST", `/api/rental-applications/${a.id}`, { action }, a.id + action, ok)} /></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <ul className="rn-cards" aria-label="Applications compared">
              {desk.applications.map(a => (
                <li key={a.id} className="rn-item">
                  <div className="rn-top"><strong>#{a.rank} {a.applicantName}</strong><span className={`rn-pill st-${a.status}`}>{APP_STATUS[a.status] ?? a.status}</span></div>
                  <p className="muted">{a.evaluation.headline}</p>
                  <dl className="rn-crit">{a.evaluation.criteria.map(c => <div key={c.key}><dt>{c.label}</dt><dd><Cell c={c} /></dd></div>)}</dl>
                  <p className="muted">{a.viewing ? `Viewing ${when(a.viewing.startsAt)}` : "No viewing booked"}</p>
                  <Decide a={a} busy={busy} onAct={(action, ok) => call("POST", `/api/rental-applications/${a.id}`, { action }, a.id + action, ok)} />
                </li>
              ))}
            </ul>
            {desk.applications.some(a => a.note || a.noteWithheld || a.identityHidden) && (
              <details className="rn-log"><summary>Notes from applicants</summary>
                <p className="rn-hint">These are the applicants&apos; own words. Elena holds back notes that mention personal details, but she cannot catch everything: do not weigh anything personal in a note.</p>
                <ul>{desk.applications.map(a => <li key={a.id}><strong>{a.applicantName}:</strong> {a.note ? <span className="rn-wrap">{a.note}</span> : a.identityHidden ? <span className="muted">Hidden until you shortlist this applicant.</span> : a.noteWithheld ? <span className="muted">Withheld: it mentioned something personal that Elena does not use and you should not weigh.</span> : <span className="muted">No note.</span>}</li>)}</ul></details>
            )}
          </>
        )}
      </section>

      <SlotsPanel slots={desk.slots} busy={busy} onAdd={async b => call("POST", `/api/listings/${id}/rentals/slots`, b, "slot", "Viewing time added. Elena offered it to applicants who have not booked.")} onCancel={sid => call("POST", `/api/rental-slots/${sid}`, {}, sid, "Viewing time cancelled. Anyone booked was told.")} />

      <section className="rn-panel" aria-labelledby="rn-ten">
        <h2 id="rn-ten">Tenants</h2>
        <p className="rn-hint">A tenant can send repair requests. Elena sorts them by urgency and chases them until they are closed.</p>
        <form className="rn-inline" onSubmit={(e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const fd = new FormData(e.currentTarget); const appId = String(fd.get("applicationId") ?? ""); const email = String(fd.get("email") ?? "").trim(); void call("POST", `/api/listings/${id}/rentals/tenancies`, appId ? { applicationId: appId } : { email }, "tenant", "Tenant added.").then(ok => { if (ok) e.currentTarget.reset(); }); }}>
          {approved.length > 0 && <label>From an approved application<select name="applicationId" defaultValue=""><option value="">Choose…</option>{approved.map(a => <option key={a.id} value={a.id}>{a.applicantName}</option>)}</select></label>}
          <label>Or their account email<input name="email" type="email" autoComplete="off" placeholder="tenant@example.com" /></label>
          <button type="submit" disabled={busy === "tenant"}>Add tenant</button>
        </form>
        {desk.tenancies.length === 0 ? <p className="muted">No tenants yet.</p> : (
          <ul className="rn-list">{desk.tenancies.map(t => <li key={t.id} className="rn-item rn-row"><span><strong>{t.tenantName}</strong> <span className="muted">· {t.status === "active" ? "Current tenant" : "Ended"}</span></span>
            {t.status === "active" && <button type="button" className="secondary" disabled={busy === t.id} onClick={() => void call("POST", `/api/rental-tenancies/${t.id}`, {}, t.id, "Tenancy ended.")}>End tenancy</button>}</li>)}</ul>
        )}
      </section>

      <section className="rn-panel" aria-labelledby="rn-rep">
        <h2 id="rn-rep">Repairs</h2>
        {desk.repairs.length === 0 ? <p className="muted">No repair requests. Elena will sort and chase them when a tenant reports one.</p> : (
          <ul className="rn-list">
            {desk.repairs.map(r => (
              <li key={r.id} className="rn-item">
                <div className="rn-top"><strong>RR-{r.no} · {categoryLabel(r.category)}</strong><span className={`rn-pill ug-${r.urgency}`}>{URGENCY[r.urgency] ?? r.urgency}</span></div>
                <p className="rn-wrap">{r.description}</p>
                <p className="muted">{r.tenantName} · {REPAIR_STATUS[r.status] ?? r.status}{r.visitAt ? ` · visit ${when(r.visitAt)}` : ""} · Elena: {r.urgencyReason}</p>
                {r.photoIds.length > 0 && <div className="rn-photos">{r.photoIds.map(p => <a key={p} href={`/api/rental-repairs/${r.id}/photos/${p}`} target="_blank" rel="noreferrer"><img src={`/api/rental-repairs/${r.id}/photos/${p}`} alt={`Tenant photo for RR-${r.no}`} loading="lazy" /></a>)}</div>}
                {r.needsOwnerReason && <p className="rn-alert">{r.needsOwnerReason}</p>}
                {r.status === "awaiting_owner" && r.proposedContractorName && <p>Elena suggests <strong>{r.proposedContractorName}</strong>{r.proposedReasons.length ? ` (${r.proposedReasons.join(", ")})` : ""}. Approving sends a normal job offer with no price: you and the contractor agree that directly.</p>}
                {r.status === "awaiting_owner" && !r.proposedContractorName && <p className="muted">No verified contractor in your area is taking these jobs right now. Arrange it yourself or browse contractors.</p>}
                <div className="rn-actions">
                  {(r.status === "awaiting_owner" || r.status === "needs_owner") && r.proposedContractorName && <button type="button" disabled={busy === r.id + "approve"} onClick={() => void call("POST", `/api/rental-repairs/${r.id}`, { action: "approve" }, r.id + "approve", "Job offer sent. Elena will keep the tenant and you updated.")}>Approve {r.proposedContractorName}</button>}
                  {(r.status === "awaiting_owner" || r.status === "needs_owner") && <button type="button" className="secondary" disabled={busy === r.id + "choose_other"} onClick={() => void call("POST", `/api/rental-repairs/${r.id}`, { action: "choose_other" }, r.id + "choose_other", "Elena found another suggestion.")}>Suggest someone else</button>}
                  {r.urgency === "emergency" && !["emergency", "closed"].includes(r.status) && <button type="button" className="danger" disabled={busy === r.id + "send_emergency"} onClick={() => void call("POST", `/api/rental-repairs/${r.id}`, { action: "send_emergency" }, r.id + "send_emergency", "Sent to emergency contractors who are available now.")}>Send to emergency contractors now</button>}
                  {!["closed", "owner_arranging"].includes(r.status) && <button type="button" className="secondary" disabled={busy === r.id + "arrange_myself"} onClick={() => void call("POST", `/api/rental-repairs/${r.id}`, { action: "arrange_myself" }, r.id + "arrange_myself", "Okay. Elena will check with the tenant that it gets fixed.")}>I will arrange it</button>}
                  {r.status === "needs_owner" || r.status === "closed" ? <button type="button" className="secondary" disabled={busy === r.id + "reopen"} onClick={() => void call("POST", `/api/rental-repairs/${r.id}`, { action: "reopen" }, r.id + "reopen", "Reopened.")}>Reopen</button> : null}
                  {r.status !== "closed" && <button type="button" className="secondary" disabled={busy === r.id + "close"} onClick={() => void call("POST", `/api/rental-repairs/${r.id}`, { action: "close" }, r.id + "close", "Closed. The tenant was told.")}>Close</button>}
                </div>
                {r.messages.length > 0 && <details className="rn-log"><summary>What Elena sent you ({r.messages.length})</summary><ul>{r.messages.map(m => <li key={m.id}><span className="muted">{when(m.at)}{m.status !== "sent" ? ` · ${m.status.replace("_", " ")}` : ""}</span> {m.body}</li>)}</ul></details>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function Cell({ c }: { c: Crit | undefined }) {
  if (!c) return <span className="muted">—</span>;
  return <span className="rn-cell"><span className={`rn-pill cr-${c.status}`}>{CRITERION_STATUS[c.status] ?? c.status}</span><span className="rn-reason">{c.reason}</span></span>;
}

function Decide({ a, busy, onAct }: { a: App; busy: string; onAct: (action: string, ok: string) => Promise<boolean> }) {
  const closed = a.status === "declined" || a.status === "withdrawn";
  const b = (action: string) => busy === a.id + action;
  return (
    <div className="rn-actions">
      {!closed && a.status !== "shortlisted" && a.status !== "approved" && <button type="button" className="secondary" disabled={b("shortlist")} onClick={() => void onAct("shortlist", "Shortlisted. The applicant was told.")}>Shortlist</button>}
      {!closed && a.status !== "approved" && <button type="button" disabled={b("approve")} onClick={() => void onAct("approve", "Approved. The applicant was told.")}>Approve</button>}
      {!closed && a.evaluation.missing.length > 0 && <button type="button" className="secondary" disabled={b("ask_info")} onClick={() => void onAct("ask_info", "Elena asked for what is missing.")}>Ask for details</button>}
      {!closed && a.status !== "approved" && <button type="button" className="secondary" disabled={b("decline")} onClick={() => void onAct("decline", "Declined. Elena sent a neutral message with no reason.")}>Decline</button>}
      {closed && <span className="muted">No action</span>}
    </div>
  );
}

function SettingsPanel({ s, busy, onSave }: { s: Settings; busy: boolean; onSave: (s: Settings) => Promise<void> }) {
  const [v, setV] = useState(s);
  useEffect(() => setV(s), [s]);
  const num = (k: "maxRentPct" | "minHistoryMonths" | "minReferences") => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: Number(e.target.value) });
  return (
    <section className="rn-panel" aria-labelledby="rn-set">
      <h2 id="rn-set">Let Elena help</h2>
      <p className="rn-hint">Elena summarises applications against your criteria, asks applicants for what is missing, offers your viewing times, sends confirmations and reminders, and sorts and chases tenant repairs. She never accepts anyone, never agrees a price, and you can switch her off here.</p>
      <form className="rn-form" onSubmit={e => { e.preventDefault(); void onSave(v); }}>
        <label className="rn-check"><input type="checkbox" checked={v.elenaOn} onChange={e => setV({ ...v, elenaOn: e.target.checked })} /> Elena helps with this rental</label>
        <fieldset className="rn-fields"><legend>Your criteria</legend>
          <label>Rent should be at most (% of income)<input type="number" min={10} max={100} value={v.maxRentPct} onChange={num("maxRentPct")} /></label>
          <label>Rental history at least (months)<input type="number" min={0} max={120} value={v.minHistoryMonths} onChange={num("minHistoryMonths")} /></label>
          <label>References at least<input type="number" min={0} max={5} value={v.minReferences} onChange={num("minReferences")} /></label>
          <label>Earliest move-in<input type="date" value={v.moveInFrom ?? ""} onChange={e => { const { moveInFrom: _m, ...rest } = v; setV(e.target.value ? { ...rest, moveInFrom: e.target.value } : rest); }} /></label>
          <label>Latest move-in<input type="date" value={v.moveInTo ?? ""} onChange={e => { const { moveInTo: _m, ...rest } = v; setV(e.target.value ? { ...rest, moveInTo: e.target.value } : rest); }} /></label>
        </fieldset>
        <fieldset className="rn-fields" disabled={!v.elenaOn}><legend>Repairs</legend>
          <label className="rn-check"><input type="checkbox" checked={v.autoRepairOffers && v.elenaOn} onChange={e => setV({ ...v, autoRepairOffers: e.target.checked })} /> Elena sends the job offer herself (no price is agreed; you can still cancel it)</label>
          <label className="rn-check"><input type="checkbox" checked={v.autoEmergency && v.elenaOn} onChange={e => setV({ ...v, autoEmergency: e.target.checked })} /> Elena sends emergencies to emergency contractors herself (your address goes only to the contractor who accepts)</label>
          <p className="rn-hint">Both are off unless you switch them on. Otherwise Elena suggests a contractor and waits for you, and an emergency alerts you straight away with a button to send it.</p>
        </fieldset>
        <button type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
      </form>
    </section>
  );
}

function SlotsPanel({ slots, busy, onAdd, onCancel }: { slots: Slot[]; busy: string; onAdd: (b: unknown) => Promise<boolean>; onCancel: (id: string) => Promise<boolean> }) {
  const open = slots.filter(s => s.status === "open");
  return (
    <section className="rn-panel" aria-labelledby="rn-view">
      <h2 id="rn-view">Viewing times</h2>
      <p className="rn-hint">Add times that suit you. Elena offers them to applicants, books them, sends confirmations and reminders, and sends you a summary afterwards. Times are in your device&apos;s time zone.</p>
      <form className="rn-inline" onSubmit={e => { e.preventDefault(); const f = e.currentTarget; const fd = new FormData(f); const startsAt = localToIso(String(fd.get("startsAt") ?? "")); if (startsAt) void onAdd({ slots: [{ startsAt, durationMin: Number(fd.get("durationMin")), capacity: Number(fd.get("capacity")) }] }).then(ok => { if (ok) f.reset(); }); }}>
        <label>Date and time<input name="startsAt" type="datetime-local" required /></label>
        <label>Length<select name="durationMin" defaultValue="15"><option value="15">15 min</option><option value="20">20 min</option><option value="30">30 min</option></select></label>
        <label>People<select name="capacity" defaultValue="1">{[1, 2, 3, 4, 5, 6].map(n => <option key={n} value={n}>{n}</option>)}</select></label>
        <button type="submit" disabled={busy === "slot"}>Add time</button>
      </form>
      {open.length === 0 ? <p className="muted">No viewing times yet.</p> : (
        <ul className="rn-list">{open.map(s => <li key={s.id} className="rn-item rn-row"><span><strong>{when(s.startsAt)}</strong> <span className="muted">· {s.durationMin} min · {s.booked} of {s.capacity} booked</span></span>
          <button type="button" className="secondary" disabled={busy === s.id} onClick={() => void onCancel(s.id)}>Cancel time</button></li>)}</ul>
      )}
    </section>
  );
}
