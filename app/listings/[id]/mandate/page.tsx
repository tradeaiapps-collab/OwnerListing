"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { dollarsToCents, formatAud } from "../../../../src/domain/listing-details";
import type { MandateView } from "../../../../src/domain/mandate";
import { JSON_HEADERS } from "../../ui";
import "../../../styles/mandate.css";

type Loaded = {
  mandate: MandateView | null;
  history: { version: number; setBy: "owner" | "agent"; createdAt: string; changes: string[] }[];
  canEdit: boolean; asAgent: boolean;
  listing: { title: string; address: string; transactionType: "sale" | "rent"; askingPriceCents?: number };
  options: { conditions: readonly { key: string; label: string }[]; limits: { maxRounds: number; maxConcessionBps: number }; autoModeAvailable: boolean; floorKeyConfigured: boolean };
};
type Form = { floor: string; target: string; rounds: string; concession: string; conditions: string[]; minDays: string; maxDays: string; quietFrom: string; quietTo: string };

const dollars = (c: number) => (c / 100).toLocaleString("en-AU", { maximumFractionDigits: 2, useGrouping: true });
const when = (iso: string) => new Date(iso).toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

function formFrom(m: MandateView | null, asking?: number): Form {
  return m ? {
    floor: "", target: dollars(m.targetPriceCents), rounds: String(m.maxCounterRounds), concession: String(m.maxConcessionBpsPerRound / 100),
    conditions: [...m.approvedConditions], minDays: String(m.settlementMinDays), maxDays: String(m.settlementMaxDays), quietFrom: m.quietHours.from, quietTo: m.quietHours.to
  } : {
    floor: "", target: asking ? dollars(asking) : "", rounds: "2", concession: "1", conditions: ["finance", "building_pest"], minDays: "30", maxDays: "60", quietFrom: "20:00", quietTo: "08:00"
  };
}

/**
 * Negotiation mandate editor: the limits the AI works within when it drafts replies to offers. The owner edits;
 * an appointed agent edits only with a full appointment. The lowest price is hidden once saved (reveal needs MFA,
 * which is not built yet), so it can only be replaced, never read back.
 */
export default function MandatePage() {
  const { id } = useParams<{ id: string }>();
  const [d, setD] = useState<Loaded | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [changeFloor, setChangeFloor] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => fetch(`/api/listings/${id}/mandate`).then(async r => {
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { setError(r.status === 401 ? "Sign in to see this mandate." : r.status === 404 ? "Listing not found." : body.error ?? "Could not load the mandate."); return; }
    setD(body); setForm(formFrom(body.mandate, body.listing.askingPriceCents)); setChangeFloor(!body.mandate); setErrors({});
  }).catch(() => setError("Could not load the mandate."));
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm(f => f && { ...f, [k]: e.target.value });
  const toggle = (key: string) => setForm(f => f && { ...f, conditions: f.conditions.includes(key) ? f.conditions.filter(c => c !== key) : [...f.conditions, key] });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!d || !form) return;
    const local: Record<string, string> = {};
    const target = dollarsToCents(form.target);
    const floor = changeFloor ? dollarsToCents(form.floor) : undefined;
    if (target === undefined) local["targetPriceCents"] = "Enter a dollar amount, like 1,650,000.";
    if (changeFloor && floor === undefined) local["floorPriceCents"] = "Enter a dollar amount, like 1,550,000.";
    const conc = Number(form.concession);
    if (!/^\d+(\.\d{1,2})?$/.test(form.concession) || conc > 10) local["maxConcessionBpsPerRound"] = "Between 0% and 10%.";
    if (Object.keys(local).length) { setErrors(local); setError("Check the highlighted fields."); return; }
    setBusy(true); setError(""); setNotice(""); setErrors({});
    const body = {
      expectedVersion: d.mandate?.version ?? 0, ...(floor !== undefined ? { floorPriceCents: floor } : {}), targetPriceCents: target,
      maxCounterRounds: Number(form.rounds), maxConcessionBpsPerRound: Math.round(conc * 100), approvedConditions: form.conditions,
      settlementMinDays: Number(form.minDays), settlementMaxDays: Number(form.maxDays), autoModeEnabled: false, quietHours: { from: form.quietFrom, to: form.quietTo }
    };
    try {
      const r = await fetch(`/api/listings/${id}/mandate`, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(body) });
      const res = await r.json().catch(() => ({}));
      if (r.ok) { setNotice(`Saved as version ${res.mandate.version}.`); await load(); }
      else { setError(res.error ?? "Could not save."); setErrors(res.fields ?? {}); }
    } catch { setError("Could not save."); } finally { setBusy(false); }
  }

  if (error && !d) return <main className="narrow"><p role="alert">{error}</p></main>;
  if (!d || !form) return <main><p className="muted" role="status">Loading the mandate...</p></main>;

  const tx = d.listing.transactionType;
  const unit = tx === "rent" ? " per week" : "";
  const readOnly = !d.canEdit;
  const err = (k: string) => errors[k] ? <span className="field-error" id={`${k}-err`}>{errors[k]}</span> : null;
  const aria = (k: string) => (errors[k] ? { "aria-invalid": true, "aria-describedby": `${k}-err` } : {});
  const conds = d.options.conditions.filter(c => form.conditions.includes(c.key)).map(c => c.label.replace(/^Subject to /, "").toLowerCase());

  return (
    <main className="mandate">
      <nav className="crumbs" aria-label="Breadcrumb">
        <ol><li><a href={d.asAgent ? "/agent/listings" : "/listings/mine"}>{d.asAgent ? "Appointed listings" : "My listings"}</a></li><li><a href={`/listings/${id}/offers`}>Offers</a></li><li aria-current="page">Mandate</li></ol>
      </nav>
      <header className="md-head">
        <h1>Negotiation mandate</h1>
        <p className="muted">{d.listing.title} · {d.listing.address}</p>
        <p>These are the limits the AI assistant works within when it drafts replies to offers. It only ever drafts: every reply waits for {d.asAgent ? "approval" : "your approval"}, and only the owner can accept an offer.</p>
      </header>
      {readOnly && <p className="notice"><strong>View only</strong>Your appointment covers enquiries and offers. Ask the owner for a full appointment to change the mandate.</p>}
      {!d.options.floorKeyConfigured && !readOnly && <p role="alert">The lowest price cannot be saved on this site yet (MANDATE_FLOOR_KEY is not set). Ask your administrator.</p>}

      <div className="md-layout">
        <form className="md-form" onSubmit={save} noValidate>
          <fieldset className="form-section" disabled={readOnly}>
            <legend>Prices</legend>
            <p className="form-hint">{d.listing.askingPriceCents ? `Your advertised price is ${formatAud(d.listing.askingPriceCents)}${unit}.` : "No advertised price is set on this listing."}</p>
            <div className="form-grid">
              <div className="field">
                <span id="floor-l">Lowest price you would accept</span>
                {d.mandate && !changeFloor ? (
                  <div className="md-masked">
                    <span aria-labelledby="floor-l"><span aria-hidden="true">$ • • • • • •</span><span className="sr-only">Hidden</span></span>
                    {!readOnly && <button type="button" className="linklike" onClick={() => setChangeFloor(true)}>Change</button>}
                  </div>
                ) : (
                  <input aria-labelledby="floor-l" inputMode="decimal" placeholder="e.g. 1,550,000" value={form.floor} onChange={set("floor")} {...aria("floorPriceCents")} />
                )}
                <span className="hint">Confidential. Never shown to buyers or the AI&apos;s replies, and hidden here once saved.</span>
                {err("floorPriceCents")}
              </div>
              <label className="field">Target price
                <input inputMode="decimal" placeholder="e.g. 1,650,000" value={form.target} onChange={set("target")} {...aria("targetPriceCents")} />
                <span className="hint">An offer at or above this is handed straight to {d.asAgent ? "the owner" : "you"}.</span>
                {err("targetPriceCents")}
              </label>
            </div>
          </fieldset>

          <fieldset className="form-section" disabled={readOnly}>
            <legend>Negotiation limits</legend>
            <div className="form-grid">
              <label className="field">Counter rounds per buyer
                <select value={form.rounds} onChange={set("rounds")} {...aria("maxCounterRounds")}>
                  {Array.from({ length: d.options.limits.maxRounds + 1 }, (_, i) => <option key={i} value={i}>{i === 0 ? "None (always ask me)" : `${i} round${i > 1 ? "s" : ""}`}</option>)}
                </select>
                {err("maxCounterRounds")}
              </label>
              <label className="field">Largest step down per round
                <span className="md-suffix"><input inputMode="decimal" value={form.concession} onChange={set("concession")} {...aria("maxConcessionBpsPerRound")} /><span aria-hidden="true">%</span></span>
                <span className="hint">Of the previous asking figure. 0% to 10%.</span>
                {err("maxConcessionBpsPerRound")}
              </label>
            </div>
          </fieldset>

          <fieldset className="form-section" disabled={readOnly}>
            <legend>Conditions you accept</legend>
            <p className="form-hint">An offer with any other condition goes to {d.asAgent ? "the owner" : "you"} to decide.</p>
            <div className="md-checks">
              {d.options.conditions.map(c => (
                <label key={c.key} className="check"><input type="checkbox" checked={form.conditions.includes(c.key)} onChange={() => toggle(c.key)} />{c.label}</label>
              ))}
            </div>
            {err("approvedConditions")}
          </fieldset>

          <fieldset className="form-section" disabled={readOnly}>
            <legend>Settlement and timing</legend>
            <div className="form-grid">
              <label className="field">Shortest settlement (days)
                <input type="number" min={1} max={365} value={form.minDays} onChange={set("minDays")} {...aria("settlementMinDays")} />{err("settlementMinDays")}
              </label>
              <label className="field">Longest settlement (days)
                <input type="number" min={1} max={365} value={form.maxDays} onChange={set("maxDays")} {...aria("settlementMaxDays")} />{err("settlementMaxDays")}
              </label>
              <label className="field">Quiet hours from
                <input type="time" value={form.quietFrom} onChange={set("quietFrom")} {...aria("quietHours")} />
              </label>
              <label className="field">Quiet hours until
                <input type="time" value={form.quietTo} onChange={set("quietTo")} {...aria("quietHours")} />
                <span className="hint">No drafts are sent to buyers in this window.</span>{err("quietHours")}
              </label>
            </div>
          </fieldset>

          <fieldset className="form-section" disabled={readOnly}>
            <legend>Mode</legend>
            <label className="md-mode"><input type="radio" name="mode" checked readOnly /><span><strong>Assisted</strong><br /><span className="muted">The AI drafts; {d.asAgent ? "a person" : "you"} approve every message before it goes.</span></span></label>
            <label className="md-mode is-disabled" title="Available after launch gate G3"><input type="radio" name="mode" disabled /><span><strong>Auto</strong> <span className="badge">After launch gate G3</span><br /><span className="muted">Not available yet. Even then, accepting an offer always stays with the owner.</span></span></label>
          </fieldset>

          {!readOnly && (
            <div className="md-savebar">
              <button type="submit" disabled={busy}>{busy ? "Saving..." : d.mandate ? "Save new version" : "Save mandate"}</button>
              <button type="button" className="secondary" disabled={busy} onClick={() => { setForm(formFrom(d.mandate, d.listing.askingPriceCents)); setChangeFloor(!d.mandate); setErrors({}); setError(""); }}>Discard changes</button>
              {notice && <span role="status" className="md-ok">{notice}</span>}
            </div>
          )}
          {error && <p role="alert">{error}</p>}
        </form>

        <aside className="md-aside">
          <section className="panel">
            <h2>In plain words</h2>
            <ul className="md-summary">
              <li>The AI may suggest counters for up to <strong>{form.rounds === "0" ? "no" : form.rounds} round{form.rounds === "1" ? "" : "s"}</strong>, stepping down at most <strong>{form.concession || "0"}%</strong> each time.</li>
              <li>It will never go below your lowest price, and never mention it.</li>
              <li>Conditions it can work with: <strong>{conds.length ? conds.join(", ") : "none"}</strong>.</li>
              <li>Settlement between <strong>{form.minDays}</strong> and <strong>{form.maxDays}</strong> days. Quiet from {form.quietFrom} to {form.quietTo}.</li>
              <li>Anything else, a best-so-far offer, or an offer at target comes to {d.asAgent ? "the owner" : "you"}.</li>
            </ul>
          </section>
          <section className="panel">
            <h2>History</h2>
            {d.history.length === 0 ? <p className="muted">No mandate saved yet.</p> : (
              <ol className="md-history">
                {d.history.map(h => (
                  <li key={h.version}>
                    <p><strong>Version {h.version}</strong> · {h.setBy === "agent" ? "Agent" : "Owner"}</p>
                    <p className="muted"><time dateTime={h.createdAt}>{when(h.createdAt)}</time></p>
                    <p>{h.changes.join(", ")}</p>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </aside>
      </div>
    </main>
  );
}
