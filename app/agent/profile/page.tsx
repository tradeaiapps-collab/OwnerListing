"use client";
import { useEffect, useState } from "react";
import { JSON_HEADERS } from "../../listings/ui";

type Profile = {
  acceptingNew: boolean; maxActiveListings: number; servicePostcodes: string[]; serviceSuburbs: string[];
  transactionTypes: string[]; useClasses: string[]; propertyTypes: string[]; bio: string;
};

const PROPERTY_TYPES = ["house", "unit", "townhouse", "land", "office", "retail", "industrial", "warehouse", "hospitality", "other"];
const splitList = (s: string) => s.split(/[,\n]/).map(x => x.trim()).filter(Boolean);

/** Agent screen: where you work, what you list and how many listings you can take. Owners see suggestions from this. */
export default function AgentProfilePage() {
  const [p, setP] = useState<Profile | null>(null);
  const [postcodes, setPostcodes] = useState("");
  const [suburbs, setSuburbs] = useState("");
  const [loadError, setLoadError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/agent/profile");
        const d = await r.json().catch(() => ({}));
        if (!r.ok) return setLoadError(r.status === 401 ? "Sign in to edit your agent profile." : d.error ?? "Could not load your profile.");
        setP(d.profile);
        setPostcodes(d.profile.servicePostcodes.join(", "));
        setSuburbs(d.profile.serviceSuburbs.join(", "));
      } catch {
        setLoadError("Could not load your profile.");
      }
    })();
  }, []);

  const toggle = (key: "transactionTypes" | "useClasses" | "propertyTypes", v: string) =>
    setP(prev => (prev ? { ...prev, [key]: prev[key].includes(v) ? prev[key].filter(x => x !== v) : [...prev[key], v] } : prev));

  async function onSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!p) return;
    setBusy(true);
    setMsg("");
    try {
      const body = { ...p, servicePostcodes: splitList(postcodes), serviceSuburbs: splitList(suburbs) };
      const r = await fetch("/api/agent/profile", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { setP(d.profile); setMsg("Saved."); } else setMsg(d.error ?? "Could not save your profile.");
    } catch {
      setMsg("Could not save your profile.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Agent profile</h1>
      <p className="muted">Owners are shown licensed agents whose areas and experience match their listing. You only get a listing if the owner invites you and you accept.</p>
      {loadError && <p role="alert">{loadError}</p>}
      {!loadError && p === null && <p className="muted" role="status">Loading…</p>}
      {p && (
        <form className="stack" onSubmit={onSave}>
          <label><input type="checkbox" checked={p.acceptingNew} onChange={e => setP({ ...p, acceptingNew: e.target.checked })} /> Accepting new listings</label>
          <label>Most listings at once
            <input type="number" min={1} max={500} value={p.maxActiveListings} onChange={e => setP({ ...p, maxActiveListings: Number(e.target.value) })} required />
          </label>
          <label>Postcodes you cover (comma separated)
            <input value={postcodes} onChange={e => setPostcodes(e.target.value)} placeholder="4000, 4005, 4064" />
          </label>
          <label>Suburbs you cover (comma separated)
            <input value={suburbs} onChange={e => setSuburbs(e.target.value)} placeholder="New Farm, Paddington" />
          </label>
          <fieldset>
            <legend>You handle</legend>
            {[["sale", "Sales"], ["rent", "Rentals"]].map(([v, l]) => (
              <label key={v}><input type="checkbox" checked={p.transactionTypes.includes(v!)} onChange={() => toggle("transactionTypes", v!)} /> {l}</label>
            ))}
            {[["residential", "Residential"], ["commercial", "Commercial"]].map(([v, l]) => (
              <label key={v}><input type="checkbox" checked={p.useClasses.includes(v!)} onChange={() => toggle("useClasses", v!)} /> {l}</label>
            ))}
          </fieldset>
          <fieldset>
            <legend>Property types</legend>
            {PROPERTY_TYPES.map(t => (
              <label key={t}><input type="checkbox" checked={p.propertyTypes.includes(t)} onChange={() => toggle("propertyTypes", t)} /> {t}</label>
            ))}
          </fieldset>
          <label>About you
            <textarea value={p.bio} onChange={e => setP({ ...p, bio: e.target.value })} rows={4} maxLength={1000} />
          </label>
          <button type="submit" disabled={busy}>{busy ? "Saving…" : "Save profile"}</button>
          {msg && <p role="status">{msg}</p>}
        </form>
      )}
    </main>
  );
}
