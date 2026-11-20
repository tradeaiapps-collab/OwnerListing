"use client";
import { useEffect, useState } from "react";
import { JSON_HEADERS } from "../../listings/ui";

type Kind = "photographer" | "inspector";
type Form = { acceptingNew: boolean; suburbs: string; postcodes: string };
const EMPTY: Form = { acceptingNew: true, suburbs: "", postcodes: "" };
const TITLES: Record<Kind, string> = { photographer: "Photographer", inspector: "Building inspector" };

/** Photographers and inspectors say where they work. Elena then sends them the first invitation for new listings there. They still accept or decline each one. */
export default function ContractorProfile() {
  const [forms, setForms] = useState<Record<Kind, Form>>({ photographer: EMPTY, inspector: EMPTY });
  const [msg, setMsg] = useState<Record<Kind, string>>({ photographer: "", inspector: "" });
  const [error, setError] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch("/api/contractor-profile");
        if (r.status === 401) { setError("Sign in to set your service areas."); return; }
        const d = await r.json();
        const conv = (p: { acceptingNew: boolean; serviceSuburbs: string[]; servicePostcodes: string[] } | null): Form => (p ? { acceptingNew: p.acceptingNew, suburbs: p.serviceSuburbs.join(", "), postcodes: p.servicePostcodes.join(", ") } : EMPTY);
        setForms({ photographer: conv(d.profiles.photographer), inspector: conv(d.profiles.inspector) });
      } catch { setError("Could not load your service areas."); }
    })();
  }, []);

  async function save(kind: Kind) {
    const f = forms[kind], split = (s: string) => s.split(/[,\n]/).map(x => x.trim()).filter(Boolean);
    setMsg(m => ({ ...m, [kind]: "" })); setError("");
    const r = await fetch("/api/contractor-profile", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ kind, acceptingNew: f.acceptingNew, serviceSuburbs: split(f.suburbs), servicePostcodes: split(f.postcodes) }) });
    const d = await r.json().catch(() => ({}));
    if (r.ok) setMsg(m => ({ ...m, [kind]: "Saved." })); else setError(d.error ?? "Could not save.");
  }

  return (
    <main>
      <h1>Your service areas</h1>
      <p className="muted">Tell us where you work. When an owner lists a home in one of these suburbs or postcodes, Elena invites you. You can always accept or decline. <a href="/contractor/emergency">Set up emergency jobs</a></p>
      {error && <p role="alert">{error}</p>}
      {(["photographer", "inspector"] as const).map(kind => (
        <form key={kind} className="panel" onSubmit={e => { e.preventDefault(); void save(kind); }}>
          <h2>{TITLES[kind]}</h2>
          <label className="field"><span>Suburbs, separated by commas</span><input value={forms[kind].suburbs} onChange={e => setForms({ ...forms, [kind]: { ...forms[kind], suburbs: e.target.value } })} /></label>
          <label className="field"><span>Postcodes, separated by commas</span><input inputMode="numeric" value={forms[kind].postcodes} onChange={e => setForms({ ...forms, [kind]: { ...forms[kind], postcodes: e.target.value } })} /></label>
          <label className="field"><span><input type="checkbox" checked={forms[kind].acceptingNew} onChange={e => setForms({ ...forms, [kind]: { ...forms[kind], acceptingNew: e.target.checked } })} /> Taking new jobs</span></label>
          <button type="submit">Save {TITLES[kind].toLowerCase()} areas</button>
          {msg[kind] && <p role="status">{msg[kind]}</p>}
        </form>
      ))}
    </main>
  );
}
