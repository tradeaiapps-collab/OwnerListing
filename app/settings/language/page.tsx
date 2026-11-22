"use client";
import { useEffect, useState } from "react";
import { DEFAULT_SETTINGS, TIME_ZONE_CHOICES, type AccountSettings } from "../../../src/domain/account-settings";
import { LOCALES } from "../../../src/domain/i18n";
import { useT } from "../../i18n-provider";
import { JSON_HEADERS } from "../../listings/ui";
import "../../styles/settings.css";

export default function Settings() {
  const t = useT();
  const [state, setState] = useState<"loading" | "signedOut" | "error" | "ok">("loading");
  const [s, setS] = useState<AccountSettings>(DEFAULT_SETTINGS);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);
  const [enabled, setEnabled] = useState<string[]>([]);

  useEffect(() => {
    fetch("/api/settings")
      .then(async r => {
        if (r.status === 401) return setState("signedOut");
        if (!r.ok) return setState("error");
        const d = (await r.json()) as { settings: AccountSettings; enabledLocales?: string[] };
        setS(d.settings);
        setEnabled(d.enabledLocales ?? []);
        setState("ok");
      })
      .catch(() => setState("error"));
  }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setMsg(""); setOk(false);
    const r = await fetch("/api/settings", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(s) }).catch(() => null);
    if (!r) { setBusy(false); return setMsg(t("Could not save. Check your connection and try again.")); }
    const d = (await r.json().catch(() => ({}))) as { error?: string; settings?: AccountSettings; enabledLocales?: string[] };
    setBusy(false);
    if (r.status === 401) return setState("signedOut");
    if (!r.ok || !d.settings) return setMsg(d.error ?? t("Could not save. Please try again."));
    setS(d.settings);
    setEnabled(d.enabledLocales ?? []);
    setOk(true);
    const live = d.settings.locale === DEFAULT_SETTINGS.locale || (d.enabledLocales ?? []).includes(d.settings.locale);
    setMsg(live ? t("Saved. Your language and time zone are updated.") : "Saved. This language is not switched on yet, so pages still show in English. Your choice is kept and applies as soon as it is.");
    // Reload so the page picks up the saved language and direction.
    window.setTimeout(() => window.location.reload(), live ? 600 : 2500);
  };

  if (state === "loading") return <main><p className="muted" role="status">{t("Loading…")}</p></main>;
  if (state === "signedOut") return <main><h1>{t("Settings")}</h1><p role="alert"><a href="/login?next=/settings/language">{t("Sign in")}</a> {t("to change your settings.")}</p></main>;
  if (state === "error") return <main><h1>{t("Settings")}</h1><p role="alert">{t("Could not load your settings.")}</p></main>;

  const zones = TIME_ZONE_CHOICES.includes(s.timeZone) ? TIME_ZONE_CHOICES : [s.timeZone, ...TIME_ZONE_CHOICES];
  return (
    <main>
      <h1>{t("Settings")}</h1>
      <p className="muted">{t("Times are stored in UTC and shown in your time zone. Legal documents, disclosures and terms stay in English.")}</p>
      <form className="settings-form" onSubmit={save}>
        <label>
          {t("Language")}
          <select value={s.locale} onChange={e => { setS({ ...s, locale: e.target.value }); setMsg(""); }}>
            {LOCALES.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
          </select>
          <span className="hint">{t("A language shows only once it has been reviewed and switched on. Until then you see English.")}</span>
        </label>
        <label>
          {t("Time zone")}
          <select value={s.timeZone} onChange={e => { setS({ ...s, timeZone: e.target.value }); setMsg(""); }}>
            {zones.map(z => <option key={z} value={z}>{z}</option>)}
          </select>
        </label>
        {msg ? <p role={ok ? "status" : "alert"}>{msg}</p> : null}
        <button type="submit" disabled={busy}>{busy ? t("Saving…") : t("Save settings")}</button>
      </form>
      <p><a href="/terms?from=/settings/language">{t("Terms and privacy")}</a> · <a href="/dashboard">{t("Dashboard")}</a></p>
    </main>
  );
}
