"use client";
import { useCallback, useEffect, useState } from "react";
import "../../styles/staff.css";
import "../../styles/teams.css";
import "../../styles/white-label.css";
import { loadError, postStaff } from "../staff-api";

type Row = {
  id: string; teamName: string; status: "draft" | "active" | "suspended"; name: string | null; tagline: string | null; primary: string; secondary: string;
  hasLogo: boolean; updatedAt: string; reviewedAt: string | null; domains: { host: string; verified: boolean }[];
};
const LABEL = { draft: "Waiting for review", active: "Live", suspended: "Suspended" } as const;
const when = (iso: string) => new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });

/** Platform staff approve, suspend or send back agency brands (theme.edit). A brand only goes live with a verified domain. */
export default function StaffWhiteLabel() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/staff/white-label").catch(() => null);
    if (!r?.ok) return setError(loadError(r?.status ?? 0));
    setRows((await r.json()).tenants);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function decide(t: Row, status: Row["status"]) {
    const verb = status === "active" ? "Approve" : status === "suspended" ? "Suspend" : "Send back to draft";
    if (!window.confirm(`${verb} the brand "${t.name ?? t.teamName}"?`)) return;
    setBusy(true); setNote(""); setError("");
    const r = await postStaff("/api/staff/white-label", { tenantId: t.id, status });
    setBusy(false);
    if (r.ok) { setNote(`${t.name ?? t.teamName}: ${LABEL[status].toLowerCase()}.`); await load(); } else setError(String(r.data["error"] ?? "That did not work."));
  }

  if (!rows) return <main><h1>Agency brands</h1>{error ? <p role="alert">{error}</p> : <p className="muted">Loading…</p>}</main>;
  return (
    <main className="wl">
      <h1>Agency brands</h1>
      <p className="muted">Agencies show their own name, colours and logo on their own domain. Check the name is theirs to use and the domain is verified, then approve. Suspending switches the brand off within a minute.</p>
      {error && <p role="alert">{error}</p>}
      {note && <p className="staff-notice" role="status">{note}</p>}
      {rows.length === 0 ? <p className="muted">No agency has set up a brand yet.</p> : (
        <div className="team-table-wrap">
          <table className="team-table">
            <caption className="sr-only">Agency brands</caption>
            <thead><tr><th scope="col">Brand</th><th scope="col">Agency team</th><th scope="col">Domains</th><th scope="col">Status</th><th scope="col">Updated</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {rows.map(t => (
                <tr key={t.id}>
                  <td className="name"><strong>{t.name ?? "(no name)"}</strong><br /><span className="muted">{t.tagline}</span><br />
                    <span aria-label={`Colours ${t.primary} and ${t.secondary}`}><span className="wl-dot" style={{ background: t.primary }} /> <span className="wl-dot" style={{ background: t.secondary }} /> {t.hasLogo ? "Logo uploaded" : "No logo"}</span></td>
                  <td className="name">{t.teamName}</td>
                  <td className="name">{t.domains.length === 0 ? <span className="muted">None</span> : t.domains.map(d => <div key={d.host}>{d.host} <span className="wl-badge" data-ok={d.verified}>{d.verified ? "Verified" : "Not verified"}</span></div>)}</td>
                  <td>{LABEL[t.status]}</td>
                  <td>{when(t.reviewedAt ?? t.updatedAt)}</td>
                  <td className="team-actions">
                    {t.status !== "active" && <button type="button" onClick={() => void decide(t, "active")} disabled={busy || !t.domains.some(d => d.verified)}>Approve</button>}{" "}
                    {t.status === "active" && <button type="button" className="secondary" onClick={() => void decide(t, "suspended")} disabled={busy}>Suspend</button>}{" "}
                    {t.status === "active" && <button type="button" className="secondary" onClick={() => void decide(t, "draft")} disabled={busy}>Send back</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
