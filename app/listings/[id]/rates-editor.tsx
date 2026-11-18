"use client";
import { useCallback, useEffect, useState } from "react";
import { dollarsToCents, formatAud } from "../../../src/domain/listing-details";
import type { ListingRates, RatePeriod } from "../../../src/domain/listing-rates";
import { JSON_HEADERS } from "../ui";
import "../../styles/listing-rates.css";

interface Row { amount: string; period: RatePeriod }
const toRow = (c: { cents: number; period: RatePeriod } | undefined): Row => ({ amount: c ? (c.cents / 100).toFixed(2) : "", period: c?.period ?? "quarter" });

function ChargeFields({ legend, row, onChange, disabled }: { legend: string; row: Row; onChange: (r: Row) => void; disabled: boolean }) {
  return (
    <fieldset className="lr-row">
      <legend>{legend}</legend>
      <label>Amount on your notice (AUD)
        <input inputMode="decimal" value={row.amount} disabled={disabled} placeholder="for example 520.40" onChange={e => onChange({ ...row, amount: e.target.value })} />
      </label>
      <label>For each
        <select value={row.period} disabled={disabled} onChange={e => onChange({ ...row, period: e.target.value as RatePeriod })}>
          <option value="quarter">Quarter</option>
          <option value="year">Year</option>
        </select>
      </label>
    </fieldset>
  );
}

/** Seller form for council and water rates (sale listings only; renders nothing for a rental or when the listing cannot be edited by this user). */
export function RatesEditor({ listingId }: { listingId: string }) {
  const [shown, setShown] = useState(false);
  const [council, setCouncil] = useState<Row>(toRow(undefined));
  const [water, setWater] = useState<Row>(toRow(undefined));
  const [usage, setUsage] = useState<"" | "yes" | "no">("");
  const [asAt, setAsAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const apply = useCallback((r: ListingRates) => {
    setCouncil(toRow(r.council)); setWater(toRow(r.water));
    setUsage(r.waterUsageBilledSeparately === undefined ? "" : r.waterUsageBilledSeparately ? "yes" : "no");
    setAsAt(r.asAt ?? "");
  }, []);
  useEffect(() => {
    fetch(`/api/listings/${listingId}/rates`).then(async r => {
      if (!r.ok) return;
      const d = await r.json();
      if (d.editable) { apply(d.rates ?? {}); setShown(true); }
    }).catch(() => undefined);
  }, [listingId, apply]);
  if (!shown) return null;

  function charge(row: Row, name: string): { ok: true; value: { cents: number; period: RatePeriod } | undefined } | { ok: false; message: string } {
    if (row.amount.trim() === "") return { ok: true, value: undefined };
    const cents = dollarsToCents(row.amount);
    if (cents === undefined || cents < 1) return { ok: false, message: `${name}: enter an amount like 520.40.` };
    return { ok: true, value: { cents, period: row.period } };
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg("");
    const c = charge(council, "Council rates"), w = charge(water, "Water rates");
    if (!c.ok) return setMsg(c.message);
    if (!w.ok) return setMsg(w.message);
    const body: Record<string, unknown> = {};
    if (c.value) body["council"] = c.value;
    if (w.value) body["water"] = w.value;
    if (usage) body["waterUsageBilledSeparately"] = usage === "yes";
    if (asAt) body["asAt"] = asAt;
    setBusy(true);
    try {
      const r = await fetch(`/api/listings/${listingId}/rates`, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { apply(d.rates ?? {}); setMsg(d.view?.totalYearly ? `Saved. Combined about ${d.view.totalYearly}.` : "Saved."); } else setMsg(d.error ?? "Could not save.");
    } catch { setMsg("Could not save."); } finally { setBusy(false); }
  }

  return (
    <section className="panel" aria-label="Council and water rates">
      <h2>Council and water rates</h2>
      <p className="muted">Optional. Buyers see these on your listing as figures you stated. Copy them from your latest rates notices.{council.amount && dollarsToCents(council.amount) ? ` Council: about ${formatAud((dollarsToCents(council.amount) ?? 0) * (council.period === "quarter" ? 4 : 1))} a year.` : ""}</p>
      <form className="lr-form" onSubmit={save} noValidate>
        <ChargeFields legend="Council rates" row={council} onChange={setCouncil} disabled={busy} />
        <ChargeFields legend="Water rates" row={water} onChange={setWater} disabled={busy} />
        <label>Is water use billed on top of the water rate?
          <select value={usage} disabled={busy} onChange={e => setUsage(e.target.value as "" | "yes" | "no")}>
            <option value="">Not stated</option>
            <option value="yes">Yes, billed separately</option>
            <option value="no">No, included or not applicable</option>
          </select>
        </label>
        <label>Date of the rates notice
          <input type="date" value={asAt} disabled={busy} onChange={e => setAsAt(e.target.value)} />
        </label>
        <div className="actions"><button type="submit" disabled={busy}>{busy ? "Saving..." : "Save rates"}</button></div>
        {msg && <p role="status">{msg}</p>}
      </form>
    </section>
  );
}
