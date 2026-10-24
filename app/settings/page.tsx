"use client";
import { useEffect, useState } from "react";
import { DEFAULT_SETTINGS, TIME_ZONE_CHOICES, type AccountSettings } from "../../src/domain/account-settings";
import { LOCALES } from "../../src/domain/i18n";
import { JSON_HEADERS } from "../listings/ui";
import "../styles/settings.css";

export default function Settings() {
  const [state, setState] = useState<"loading" | "signedOut" | "error" | "ok">("loading");
  const [s, setS] = useState<AccountSettings>(DEFAULT_SETTINGS);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then(async r => {
        if (r.status === 401) return setState("signedOut");
        if (!r.ok) return setState("error");
        setS(((await r.json()) as { settings: AccountSettings }).settings);
        setState("ok");
      })
      .catch(() => setState("error"));
  }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setMsg("");
    const r = await fetch("/api/settings", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(s) }).catch(() => null);
    setBusy(false);
    if (!r) return setMsg("Could not save. Check your connection and try again.");
    const d = (await r.json().catch(() => ({}))) as { error?: string };
    setMsg(r.ok ? "Saved." : d.error ?? "Could not save.");
  };

  if (state === "loading") return <main><p className="muted" role="status">Loading…</p></main>;
  if (state === "signedOut") return <main><h1>Settings</h1><p role="alert"><a href="/api/auth/google/start?next=/settings">Sign in</a> to change your settings.</p></main>;
  if (state === "error") return <main><h1>Settings</h1><p role="alert">Could not load your settings.</p></main>;

  const zones = TIME_ZONE_CHOICES.includes(s.timeZone) ? TIME_ZONE_CHOICES : [s.timeZone, ...TIME_ZONE_CHOICES];
  return (
    <main>
      <h1>Settings</h1>
      <p className="muted">Times are stored in UTC and shown in your time zone. Legal documents, disclosures and terms stay in English.</p>
      <form className="settings-form" onSubmit={save}>
        <label>
          Language
          <select value={s.locale} onChange={e => setS({ ...s, locale: e.target.value })}>
            {LOCALES.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
          </select>
          <span className="hint">A language shows only once it has been reviewed and switched on. Until then you see English.</span>
        </label>
        <label>
          Time zone
          <select value={s.timeZone} onChange={e => setS({ ...s, timeZone: e.target.value })}>
            {zones.map(z => <option key={z} value={z}>{z}</option>)}
          </select>
        </label>
        {msg ? <p role="status">{msg}</p> : null}
        <button type="submit" disabled={busy}>{busy ? "Saving…" : "Save settings"}</button>
      </form>
      <p><a href="/terms">Terms and privacy</a> · <a href="/dashboard">Dashboard</a></p>
    </main>
  );
}
