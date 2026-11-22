"use client";
import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "next/navigation";
import { JSON_HEADERS, money, readError } from "../../../rentals/shared";

type Info = { address: string; weeklyRentCents?: number };
type Done = { id: string; missing: string[]; noteWithheld: boolean };
const MISSING: Record<string, string> = { income: "your weekly household income", history: "your rental history", references: "how many references you can offer", move_in: "the date you would like to move in" };

/** Apply to rent. Four facts and an optional note. Elena summarises them for the owner against the owner's criteria; she never declines anyone. */
export default function ApplyPage() {
  const { id } = useParams<{ id: string }>();
  const [info, setInfo] = useState<Info | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<Done | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const r = await fetch(`/api/listings/${id}/apply`);
        if (!live) return;
        if (r.ok) setInfo(await r.json());
        else setLoadError(r.status === 401 ? "Sign in to apply for this rental." : r.status === 404 ? "This rental is not open for applications." : await readError(r, "Could not load this rental."));
      } catch { if (live) setLoadError("Could not load this rental. Check your connection and try again."); }
    })();
    return () => { live = false; };
  }, [id]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const body: Record<string, unknown> = {};
    for (const k of ["weeklyIncome", "rentalHistoryMonths", "referencesCount", "moveInDate", "note"]) { const v = String(fd.get(k) ?? "").trim(); if (v) body[k] = v; }
    setBusy(true); setError("");
    try {
      const r = await fetch(`/api/listings/${id}/apply`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
      if (r.ok) setDone(await r.json()); else setError(await readError(r, "Could not send your application."));
    } catch { setError("Could not send your application. Try again."); } finally { setBusy(false); }
  }

  if (loadError) return <main className="rn-page"><h1>Apply to rent</h1><p className="rn-alert" role="alert">{loadError}</p></main>;
  if (!info) return <main className="rn-page"><h1>Apply to rent</h1><p className="muted" role="status">Loading…</p></main>;
  if (done) return (
    <main className="rn-page">
      <h1>Application sent</h1>
      <section className="rn-panel" aria-live="polite">
        <p>The owner of <strong>{info.address}</strong> has your application. They decide; Elena only summarises it and never declines anyone.</p>
        {done.missing.length > 0 && <p>Elena will ask you for: {done.missing.map(m => MISSING[m] ?? m).join(", ")}. You can update your application any time.</p>}
        {done.noteWithheld && <p className="rn-hint">Your note mentions something personal, so it was kept from the owner. Elena does not use it.</p>}
        <p><a className="button" href="/rentals">See viewing times and your application</a></p>
      </section>
    </main>
  );
  return (
    <main className="rn-page">
      <header className="rn-head"><h1>Apply to rent</h1><p className="muted">{info.address}{info.weeklyRentCents ? ` · ${money(info.weeklyRentCents)} a week` : ""}</p></header>
      <section className="rn-panel">
        <p className="rn-hint">Elena compares four things for the owner: rent against your income, your rental history, your references and your move-in date. She does not use or guess anything else about you, and every box is optional. Leaving one blank is not held against you.</p>
        <form className="rn-form" onSubmit={e => void submit(e)}>
          <label>Weekly household income before tax ($)<input name="weeklyIncome" inputMode="decimal" placeholder="1800" autoComplete="off" /></label>
          <label>Months of rental history<input name="rentalHistoryMonths" inputMode="numeric" placeholder="24 (leave blank if this is your first rental)" autoComplete="off" /></label>
          <label>References you can offer<input name="referencesCount" inputMode="numeric" placeholder="2" autoComplete="off" /></label>
          <label>Move-in date<input name="moveInDate" type="date" /></label>
          <label>Note to the owner (optional)<textarea name="note" rows={3} maxLength={500} placeholder="For example: happy to sign a 12 month lease." /></label>
          <p className="rn-hint">Leave out phone numbers, email addresses and personal details such as age, family, religion, health or where you are from. A note that includes them is kept from the owner.</p>
          {error && <p className="rn-alert" role="alert">{error}</p>}
          <button type="submit" disabled={busy}>{busy ? "Sending…" : "Send application"}</button>
        </form>
      </section>
    </main>
  );
}
