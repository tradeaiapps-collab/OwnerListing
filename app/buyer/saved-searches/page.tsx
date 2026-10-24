"use client";
import { useEffect, useState } from "react";
import type { AlertPreference, SavedSearch } from "../../../src/domain/buyer";
import { AU_JURISDICTIONS } from "../../../src/domain/jurisdiction";
import { PROPERTY_TYPES } from "../../../src/domain/listing-service";
import { JSON_HEADERS } from "../../listings/ui";
import { savedSearchFormBody } from "./form";

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
    const checked = savedSearchFormBody(new FormData(e.currentTarget));
    if ("error" in checked) { setError(checked.error); return; }
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/buyer/saved-searches", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(checked.body)
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
    <main className="narrow">
      <h1>Saved searches</h1>
      {signedOut && <p role="alert"><a href="/api/auth/google/start?as=buyer">Sign in with Google</a> to save a search.</p>}
      <p className="muted">Save what you are looking for and we can tell you when a matching property is listed.</p>
      <form className="stack" onSubmit={onSubmit} noValidate>
        <fieldset className="form-section">
          <legend>What are you looking for</legend>
          <div className="form-grid">
            <label className="field">Buy or rent
              <select name="transactionType">
                <option value="sale">Buy</option>
                <option value="rent">Rent</option>
              </select>
            </label>
            <label className="field">Use
              <select name="useClass">
                <option value="residential">Residential</option>
                <option value="commercial">Commercial</option>
              </select>
            </label>
            <label className="field">State
              <select name="jurisdiction">
                <option value="">Any state</option>
                {AU_JURISDICTIONS.map(j => <option key={j}>{j}</option>)}
              </select>
            </label>
            <label className="field">Property type
              <select name="propertyType">
                <option value="">Any property type</option>
                {PROPERTY_TYPES.map(t => <option key={t}>{t}</option>)}
              </select>
            </label>
            <label className="field span-all">Suburbs
              <input name="suburbs" placeholder="Separate suburbs with commas" />
            </label>
            <label className="field">Minimum price ($)
              <input name="minPrice" inputMode="decimal" />
            </label>
            <label className="field">Maximum price ($)
              <input name="maxPrice" inputMode="decimal" />
            </label>
            <label className="field">Minimum bedrooms
              <input name="minBedrooms" inputMode="numeric" />
            </label>
          </div>
        </fieldset>
        <div className="form-bar"><button type="submit" disabled={busy}>Save search</button></div>
      </form>
      {error && <p role="alert">{error}</p>}

      <section>
        <h2>Your searches</h2>
        {searches.length === 0 ? <p className="empty">No saved searches yet.</p> : <ul className="card-list">{searches.map(s => <li key={s.id}>{summarise(s)}</li>)}</ul>}
      </section>

      <section>
        <h2>Alerts</h2>
        <p className="muted">We only send alerts for new matching listings if you choose a channel below. You can turn a channel off at any time.</p>
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
