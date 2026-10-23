"use client";
import { useEffect, useState } from "react";
import { JSON_HEADERS } from "../../listings/ui";

interface Item {
  id: string; accountName: string; documentKind: string; documentCountry: string; expiryDate: string; hasBack: boolean;
  selfieCapturedInApp: boolean; submittedAt: string; approvals: number; needsApprovals: number; iHaveApproved: boolean; isMine: boolean;
}
const CHECKS = [
  ["documentLooksGenuine", "Document looks genuine"], ["photoMatchesSelfie", "Photo matches the selfie"],
  ["nameMatchesAccount", "Name matches the account"], ["notExpired", "Not expired"]
] as const;

export default function IdReview() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState("");
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [official, setOfficial] = useState("");

  async function load() {
    const r = await fetch("/api/staff/id");
    if (r.status === 401) return setError("Sign in required.");
    if (r.status === 403) return setError("You do not have access to identity review.");
    if (!r.ok) return setError("Could not load the queue.");
    setItems((await r.json()).items);
  }
  useEffect(() => { void load(); }, []);

  async function decide(outcome: string) {
    setError("");
    const body = { outcome, checklist: { ...checks, ...(official ? { officialStatusCheck: official } : {}) } };
    const r = await fetch(`/api/staff/id/${open}/review`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
    if (!r.ok) return setError((await r.json()).error ?? "Could not save.");
    setOpen(""); setChecks({}); setOfficial("");
    await load();
  }

  return (
    <main style={{ overflowWrap: "anywhere" }}>
      <h1>Identity review</h1>
      <p>Opening an image is recorded against your name.</p>
      {error && <p role="alert">{error}</p>}
      {items && items.length === 0 && <p>Nothing waiting.</p>}
      <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 12 }}>
        {items?.map(i => (
          <li key={i.id} style={{ border: "1px solid currentColor", padding: 12 }}>
            <p><strong>{i.accountName}</strong>: {i.documentKind.replace(/_/g, " ")} ({i.documentCountry}), expires {i.expiryDate}. Approvals {i.approvals}/{i.needsApprovals}.
              {!i.selfieCapturedInApp && " Selfie was not marked as taken in the app."}</p>
            {i.isMine || i.iHaveApproved ? <p>You cannot act on this one.</p> : open !== i.id ? (
              <button type="button" onClick={() => { setOpen(i.id); setChecks({}); setOfficial(""); }}>Open images</button>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {(["front", ...(i.hasBack ? ["back"] : []), "selfie"] as const).map(w => (
                    <img key={w} src={`/api/staff/id/${i.id}/${w}`} alt={`${w} of the document`} style={{ maxWidth: "100%", width: 300 }} />
                  ))}
                </div>
                {CHECKS.map(([k, label]) => (
                  <label key={k}><input type="checkbox" checked={checks[k] === true} onChange={e => setChecks({ ...checks, [k]: e.target.checked })} /> {label}</label>
                ))}
                {i.documentKind === "drivers_licence" && i.documentCountry === "AU" && (
                  <label>Official licence status check
                    <select value={official} onChange={e => setOfficial(e.target.value)} style={{ fontSize: 16, marginLeft: 8 }}>
                      <option value="">Select</option><option value="done">Done, current</option>
                      <option value="not_available">Not available for this state</option><option value="failed">Failed</option>
                    </select>
                  </label>
                )}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button type="button" onClick={() => decide("approve")}>Approve</button>
                  <button type="button" onClick={() => decide("needs_more")}>Ask for more</button>
                  <button type="button" onClick={() => decide("reject")}>Reject</button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
