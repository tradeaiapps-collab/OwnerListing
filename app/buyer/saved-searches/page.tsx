"use client";
import { useEffect, useState } from "react";
import type { AlertPreference, SavedSearch } from "../../../src/domain/buyer";
import { AU_JURISDICTIONS } from "../../../src/domain/jurisdiction";
import { PROPERTY_TYPES } from "../../../src/domain/listing-service";
import { JSON_HEADERS } from "../../listings/ui";

const dollarsToCents = (v: string): number | undefined => {
  const n = Number(v);
  return v.trim() !== "" && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : undefined;
};

const summarise = (s: SavedSearch) => [
  s.transactionType === "sale" ? "Buy" : "Rent",
  s.useClass,
  s.propertyTypes.length ? s.propertyTypes.join(", ") : "any type",
  s.jurisdictions.length ? s.jurisdictions.join(", ") : "any state",
  s.suburbs.length ? s.suburbs.join(", ") : "any suburb"
].join(" · ");

const consented = (prefs: AlertPreference[], channel: "email" | "sms") => {
  const p = prefs.find(x => x.channel === channel);
  return p !== undefined && p.consentGivenAt !== undefined && p.unsubscribedAt === undefined;
};

export default function SavedSearches() {
  const [searches, setSearches] = useState<SavedSearch[]>([]);
  const [prefs, setPrefs] = useState<AlertPreference[]>([]);
  const [signedOut, setSignedOut] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([fetch("/api/buyer/saved-searches"), fetch("/api/buyer/alert-preferences")])
      .then(async ([a, b]) => {
        if (a.status === 401 || b.status === 401) { setSignedOut(true); return; }
        setSearches((await a.json()).searches ?? []);
        setPrefs((await b.json()).preferences ?? []);
      })
      .catch(() => setError("Could not load your saved searches."));
  }, []);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (k: string) => String(f.get(k) ?? "");
    const state = text("jurisdiction");
    const type = text("propertyType");
    const suburbs = text("suburbs").split(",").map(s => s.trim()).filter(Boolean);
    const min = dollarsToCents(text("minPrice"));
    const max = dollarsToCents(text("maxPrice"));
    const beds = text("minBedrooms").trim() === "" ? undefined : Number(text("minBedrooms"));
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/buyer/saved-searches", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          transactionType: text("transactionType"),
          useClass: text("useClass"),
          jurisdictions: state ? [state] : [],
          propertyTypes: type ? [type] : [],
          suburbs,
          ...(min !== undefined ? { minPriceCents: min } : {}),
          ...(max !== undefined ? { maxPriceCents: max } : {}),
          ...(beds !== undefined ? { minBedrooms: beds } : {})
        })
      });
      const d = await res.json();
      if (res.status === 401) setSignedOut(true);
      else if (!res.ok) setError(d.error ?? "Could not save the search.");
      else setSearches(s => [d.search, ...s]);
    } catch {
      setError("Could not save the search.");
    } finally {
      setBusy(false);
    }
  }

  async function setConsent(channel: "email" | "sms", consent: boolean) {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/buyer/alert-preferences", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ channel, consent }) });
      const d = await res.json();
      if (!res.ok) setError(d.error ?? "Could not save your choice.");
      else setPrefs(d.preferences ?? []);
    } catch {
      setError("Could not save your choice.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Saved searches</h1>
      {signedOut && <p role="alert"><a href="/api/auth/google/start?as=buyer">Sign in with Google</a> to save a search.</p>}
      <form className="stack" onSubmit={onSubmit}>
        <select name="transactionType" aria-label="Sale or rent" defaultValue="sale">
          <option value="sale">Buy</option>
          <option value="rent">Rent</option>
        </select>
        <select name="useClass" aria-label="Use" defaultValue="residential">
          <option value="residential">Residential</option>
          <option value="commercial">Commercial</option>
        </select>
        <select name="jurisdiction" aria-label="State" defaultValue="">
          <option value="">Any state</option>
          {AU_JURISDICTIONS.map(j => <option key={j}>{j}</option>)}
        </select>
        <select name="propertyType" aria-label="Property type" defaultValue="">
          <option value="">Any property type</option>
          {PROPERTY_TYPES.map(t => <option key={t}>{t}</option>)}
        </select>
        <input name="suburbs" aria-label="Suburbs, separated by commas" placeholder="Suburbs, separated by commas" />
        <input name="minPrice" aria-label="Minimum price in dollars" inputMode="decimal" placeholder="Minimum price ($)" />
        <input name="maxPrice" aria-label="Maximum price in dollars" inputMode="decimal" placeholder="Maximum price ($)" />
        <input name="minBedrooms" aria-label="Minimum bedrooms" inputMode="numeric" placeholder="Minimum bedrooms" />
        <button type="submit" disabled={busy}>Save search</button>
      </form>
      {error && <p role="alert">{error}</p>}

      <section>
        <h2>Your searches</h2>
        {searches.length === 0 ? <p className="empty">No saved searches yet.</p> : <ul className="card-list">{searches.map(s => <li key={s.id}>{summarise(s)}</li>)}</ul>}
      </section>

      <section>
        <h2>Alerts</h2>
        <p>We only send alerts for new matching listings if you choose a channel below. You can turn a channel off at any time.</p>
        {(["email", "sms"] as const).map(channel => (
          <label key={channel} className="check">
            <input
              type="checkbox"
              checked={consented(prefs, channel)}
              disabled={busy || signedOut}
              onChange={e => setConsent(channel, e.target.checked)}
            />
            <span>{channel === "email" ? "Email me when a matching property is listed" : "Text me when a matching property is listed"}</span>
          </label>
        ))}
      </section>
      <p><a href="/listings">View listings</a></p>
    </main>
  );
}
