"use client";
import { useCallback, useEffect, useState } from "react";
import { formatKpi } from "../../../src/domain/admin-dashboard";
import { SALE_EVENT_STATES, SALE_PROPERTY_TYPES } from "../../../src/domain/sale-events";
import { MIN_REASON } from "../../../src/domain/staff-admin";
import { ReasonAction } from "../reason-action";
import { loadError, postStaff } from "../staff-api";
import "../../styles/admin.css";
import "../../styles/sale-events.css";

interface Ev {
  id: string; eventType: "sold" | "rented"; occurredAt: string; amountCents: number; source: string; origin: string | null;
  property: { address: string; suburb: string | null; postcode: string | null; state: string; propertyType: string | null };
  listingId: string | null; offerId: string | null; agent: { name: string | null } | null; buyer: { name: string | null } | null;
  counterparty: string | null; recordedBy: string | null; note: string | null; voided: { at: string; reason: string | null } | null;
}
const SOURCE: Record<string, string> = { platform: "Platform", public_record: "Public record" };
const ORIGIN: Record<string, string> = { accepted_offer: "Accepted offer", staff_manual: "Staff entry" };
const BLANK = { eventType: "sold", dollars: "", date: "", source: "public_record", address: "", state: "QLD", suburb: "", postcode: "", propertyType: "house", bedrooms: "", bathrooms: "", carSpaces: "", land: "", counterparty: "", note: "", reason: "" };
const whole = (v: string) => (v.trim() === "" ? undefined : Number(v));

/**
 * The sold and rented log. Accepted offers write their own event; staff add older sales and rentals here and void wrong ones (the row stays
 * and drops out of valuations). Prices are in dollars on screen and stored as cents; a rental is the weekly rent.
 */
export default function StaffSaleEvents() {
  const [f, setF] = useState({ q: "", type: "", status: "active", origin: "" });
  const [rows, setRows] = useState<Ev[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [form, setForm] = useState(BLANK);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (cursor?: string) => {
    setError("");
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
    if (cursor) p.set("cursor", cursor);
    const r = await fetch(`/api/staff/sale-events?${p}`).catch(() => null);
    if (!r || !r.ok) { setError(loadError(r?.status ?? 0)); return; }
    const body = await r.json();
    setRows(prev => (cursor ? [...prev, ...body.events] : body.events));
    setNext(body.nextCursor); setCanManage(body.canManage); setLoaded(true);
  }, [f]);
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function add() {
    setSaving(true); setNotice(""); setError("");
    const dollars = Number(form.dollars);
    const res = await postStaff("/api/staff/sale-events", {
      eventType: form.eventType, amountCents: Number.isFinite(dollars) ? Math.round(dollars * 100) : 0, occurredAt: form.date ? `${form.date}T00:00:00.000Z` : "",
      source: form.source, address: form.address, state: form.state, suburb: form.suburb, postcode: form.postcode, propertyType: form.propertyType,
      bedrooms: whole(form.bedrooms), bathrooms: whole(form.bathrooms), carSpaces: whole(form.carSpaces), landAreaSqm: whole(form.land),
      counterparty: form.counterparty, note: form.note, reason: form.reason
    });
    setSaving(false);
    if (!res.ok) { setError(String(res.data["error"] ?? "Could not save.")); return; }
    setNotice("Recorded. It now counts in valuations and comparable sales."); setForm(BLANK); await load();
  }

  async function sweep() {
    setNotice(""); setError("");
    const res = await postStaff("/api/staff/sale-events", { action: "sweep", reason: "Sweep accepted offers that have no sold or rented event." });
    if (!res.ok) { setError(String(res.data["error"] ?? "Could not sweep.")); return; }
    setNotice(`Checked ${res.data["checked"]} accepted offers without an event and wrote ${res.data["written"]}${Number(res.data["failed"]) > 0 ? `, ${res.data["failed"]} could not be written` : ""}.`); await load();
  }

  const set = (k: keyof typeof BLANK) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const rent = form.eventType === "rented";

  return (
    <main className="admin-page sale-events">
      <h1>Sold and rented events</h1>
      <p><a href="/staff/dashboard">Back to the admin dashboard</a></p>
      <p className="muted">
        An owner accepting an offer writes a sold or rented event here automatically. These events feed property valuations, market figures and
        comparable sales. Nothing is deleted: voiding a wrong or fallen-through event keeps the row and takes it out of the figures.
      </p>
      <form className="filters" onSubmit={e => { e.preventDefault(); void load(); }}>
        <label>Search <input value={f.q} placeholder="Address, suburb, postcode or id" onChange={e => setF({ ...f, q: e.target.value })} /></label>
        <label>Type<select value={f.type} onChange={e => setF({ ...f, type: e.target.value })}><option value="">All</option><option value="sold">Sold</option><option value="rented">Rented</option></select></label>
        <label>Entered by<select value={f.origin} onChange={e => setF({ ...f, origin: e.target.value })}><option value="">All</option><option value="accepted_offer">Accepted offer</option><option value="staff_manual">Staff entry</option></select></label>
        <label>Status<select value={f.status} onChange={e => setF({ ...f, status: e.target.value })}><option value="active">Counted</option><option value="voided">Voided</option><option value="all">All</option></select></label>
        <button type="submit">Search</button>
      </form>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {loaded && rows.length === 0 && <p className="empty">No events match. Market figures stay on &ldquo;not enough data&rdquo; until sales and rentals are recorded.</p>}
      {rows.length > 0 && (
        <div className="table-wrap"><table className="se-table">
          <thead><tr><th scope="col">Date</th><th scope="col">Event</th><th scope="col" className="se-prop">Property</th><th scope="col" className="se-num">Price</th><th scope="col">Agent and buyer or tenant</th><th scope="col">Status</th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} className={r.voided ? "se-voided" : undefined}>
                <td>{new Date(r.occurredAt).toLocaleDateString("en-AU")}</td>
                <td>{r.eventType === "sold" ? "Sold" : "Rented"}<br /><span className="muted">{SOURCE[r.source] ?? r.source}, {r.origin ? (ORIGIN[r.origin] ?? r.origin).toLowerCase() : "unknown origin"}</span></td>
                <td className="se-prop"><strong>{r.property.address}</strong><br /><span className="muted">{r.property.suburb ?? "No suburb"} {r.property.state} {r.property.postcode ?? ""}{r.property.propertyType ? `, ${r.property.propertyType}` : ""}</span></td>
                <td className="se-num">{formatKpi(r.amountCents, "cents")}{r.eventType === "rented" ? " pw" : ""}</td>
                <td>
                  <span className="muted">Agent: </span>{r.agent ? (r.agent.name ?? "Agent") : <span className="muted">none</span>}<br />
                  <span className="muted">{r.eventType === "rented" ? "Tenant: " : "Buyer: "}</span>{r.buyer ? (r.buyer.name ?? "On the platform") : (r.counterparty ?? <span className="muted">not recorded</span>)}
                </td>
                <td>
                  {r.voided ? <><span className="status-pill bad">Voided</span><br /><span className="muted">{r.voided.reason}</span></> : <span className="status-pill good">Counted</span>}
                  {r.note && <><br /><span className="muted">{r.note}</span></>}
                  {canManage && !r.voided && <div className="row-actions"><ReasonAction label="Void" danger action="void" url={`/api/staff/sale-events/${r.id}`} onDone={() => void load()} /></div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {next && <button type="button" className="secondary" onClick={() => void load(next)}>Load more</button>}

      {canManage && (
        <>
          <details className="se-add">
            <summary>Add a historical sale or rental</summary>
            <form className="stack" onSubmit={e => { e.preventDefault(); void add(); }}>
              <label>Type<select value={form.eventType} onChange={set("eventType")}><option value="sold">Sold</option><option value="rented">Rented</option></select></label>
              <label>{rent ? "Weekly rent ($)" : "Sale price ($)"}<input inputMode="decimal" required value={form.dollars} onChange={set("dollars")} /></label>
              <label>{rent ? "Date let" : "Date sold"}<input type="date" required value={form.date} onChange={set("date")} /></label>
              <label>Figure came from<select value={form.source} onChange={set("source")}><option value="public_record">Public record</option><option value="platform">Sold through the platform</option></select></label>
              <label>Street address<input required maxLength={200} value={form.address} onChange={set("address")} /></label>
              <label>Suburb<input required maxLength={80} value={form.suburb} onChange={set("suburb")} /></label>
              <label>State<select value={form.state} onChange={set("state")}>{SALE_EVENT_STATES.map(s => <option key={s}>{s}</option>)}</select></label>
              <label>Postcode<input required inputMode="numeric" pattern="\d{4}" maxLength={4} value={form.postcode} onChange={set("postcode")} /></label>
              <label>Property type<select value={form.propertyType} onChange={set("propertyType")}>{SALE_PROPERTY_TYPES.map(s => <option key={s}>{s}</option>)}</select></label>
              <label>Bedrooms<input inputMode="numeric" value={form.bedrooms} onChange={set("bedrooms")} /></label>
              <label>Bathrooms<input inputMode="numeric" value={form.bathrooms} onChange={set("bathrooms")} /></label>
              <label>Car spaces<input inputMode="numeric" value={form.carSpaces} onChange={set("carSpaces")} /></label>
              <label>Land area (sqm)<input inputMode="decimal" value={form.land} onChange={set("land")} /></label>
              <label>{rent ? "Tenant (optional)" : "Buyer (optional)"}<input maxLength={120} value={form.counterparty} onChange={set("counterparty")} /></label>
              <label>Note (optional)<input maxLength={1000} value={form.note} onChange={set("note")} /></label>
              <label>Reason for adding it (kept in the audit log)<textarea className="staff-reason" required minLength={MIN_REASON} maxLength={1000} value={form.reason} onChange={set("reason")} /></label>
              <button type="submit" disabled={saving}>{saving ? "Saving…" : "Record event"}</button>
            </form>
          </details>
          <p className="muted">Offers accepted before this screen existed, or an event that failed to save, can be filled in:{" "}
            <button type="button" className="secondary" onClick={() => void sweep()}>Write events for accepted offers</button></p>
        </>
      )}
    </main>
  );
}
