"use client";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { formatPrice } from "../../../../src/domain/listing-details";
import type { Valuation } from "../../../../src/domain/valuation";
import type { Unavailable } from "../../../../src/domain/seller-insights";
import { loadError, postStaff } from "../../staff-api";
import "../../../styles/admin.css";
import "../../../styles/valuation.css";

interface View {
  listing: { id: string; title: string; status: string; priceCents: number | null }; settingsEnabled: boolean; visibleToBuyers: boolean;
  override: { enabled: boolean; reason: string; setAt: string } | null; valuation: Valuation | Unavailable;
}
const money = (c: number) => formatPrice(c, "sale");

/** Staff view of one listing's valuation: the calculated assessment, and whether buyers see it. Needs valuation.manage. */
export default function StaffListingValuation() {
  const { id } = useParams<{ id: string }>();
  const [v, setV] = useState<View | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch(`/api/staff/listings/${id}/valuation`).catch(() => null);
    if (!r || !r.ok) { setError(r?.status === 404 ? "Listing not found." : loadError(r?.status ?? 0)); return; }
    setV(await r.json());
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  async function change(enabled: boolean | null) {
    setBusy(true); setError(""); setNote("");
    const r = await postStaff(`/api/staff/listings/${id}/valuation`, { enabled, reason });
    setBusy(false);
    if (!r.ok) { setError(String(r.data["error"] ?? "Could not save.")); return; }
    setV(r.data as unknown as View); setReason("");
    setNote(enabled === null ? "Cleared. The site setting now applies." : enabled ? "Valuation will show on this listing." : "Valuation hidden on this listing.");
  }

  const a = v?.valuation;
  const shown = v ? (v.override ? v.override.enabled : true) : true;
  return (
    <main className="admin-page">
      <h1>{v?.listing.title ?? "Listing valuation"}</h1>
      <p><a href="/staff/listings">Back to listing moderation</a> · <a href="/staff/valuation-settings">Valuation settings</a></p>
      <div aria-live="polite">
        {error && <p role="alert" className="staff-notice">{error}</p>}
        {note && <p role="status">{note}</p>}
      </div>
      {!v && !error && <p className="muted" role="status">Loading…</p>}
      {v && a && (
        <>
          <section aria-label="Valuation">
            <h2>Valuation</h2>
            {a.state === "unavailable" ? <p className="vl-off">Unavailable. {a.message}</p> : (
              <>
                <p className="vl-head"><span className={`vl-badge vl-${a.tone}`}>{a.label}</span><span className="vl-conf">Confidence: {a.confidence === "high" ? "High" : "Medium"} · {a.basedOnSales} sales</span></p>
                <p className="vl-range">Market range: {money(a.lowCents)} to {money(a.highCents)} | Asking: {money(a.askingCents)}</p>
                <p>{a.summary}</p>
                {a.saleSpeed && <p>{a.saleSpeed}</p>}
              </>
            )}
          </section>
          <section aria-label="Show on listing page">
            <h2>Show on the listing page</h2>
            <div className={`vl-switch ${v.visibleToBuyers ? "is-on" : ""}`}>
              <strong>{v.visibleToBuyers ? "Buyers can see this valuation" : "Buyers cannot see this valuation"}</strong>
            </div>
            <p className="muted">
              {!v.settingsEnabled ? "Valuations are off for the whole site (the master switch), so nothing shows until it is turned on. " : ""}
              {v.override ? `This listing is set to ${v.override.enabled ? "Yes" : "No"}: "${v.override.reason}" (${new Date(v.override.setAt).toLocaleString("en-AU")}).` : "This listing follows the site setting."}
            </p>
            <label className="vl-field">Reason (required to change)
              <input type="text" maxLength={500} value={reason} onChange={e => setReason(e.target.value)} />
            </label>
            <p className="vl-links">
              <button type="button" disabled={busy || reason.trim().length < 2 || (v.override?.enabled === true)} onClick={() => void change(true)}>Show valuation: Yes</button>
              <button type="button" className="secondary" disabled={busy || reason.trim().length < 2 || (v.override?.enabled === false)} onClick={() => void change(false)}>Show valuation: No</button>
              {v.override && <button type="button" className="secondary" disabled={busy} onClick={() => void change(null)}>Follow the site setting</button>}
            </p>
            {!shown && <p className="muted">Hidden by staff for this listing.</p>}
          </section>
        </>
      )}
    </main>
  );
}
