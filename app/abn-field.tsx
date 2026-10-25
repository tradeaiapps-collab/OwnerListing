"use client";
import { useEffect, useId, useState } from "react";
import { abnLiveState, formatAbn, type AbnCheckResult } from "../src/domain/abn";

/**
 * ABN input with live checksum feedback (same rule as the server). When the checksum passes it asks the server for the
 * register result: the entity name and GST status come from the server's reply only, and when the register is not
 * configured or cannot be reached it says "checksum valid, not verified with ABR yet". Blank is allowed.
 */
export default function AbnField({ value, onChange, label = "ABN (optional)" }: { value: string; onChange: (v: string) => void; label?: string }) {
  const id = useId();
  const live = abnLiveState(value);
  const [result, setResult] = useState<AbnCheckResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const abn = live.state === "valid" ? live.abn : undefined;
  useEffect(() => {
    setResult(null); setNote("");
    if (!abn) return;
    let stale = false;
    setBusy(true);
    const timer = setTimeout(() => {
      fetch("/api/abn/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ abn }) })
        .then(async r => {
          if (stale) return;
          if (r.ok) setResult(await r.json());
          else setNote(r.status === 429 ? "Too many checks just now. Try again in a few minutes." : "Could not reach the register. Not verified with ABR yet.");
        })
        .catch(() => { if (!stale) setNote("Could not reach the register. Not verified with ABR yet."); })
        .finally(() => { if (!stale) setBusy(false); });
    }, 500);
    return () => { stale = true; clearTimeout(timer); setBusy(false); };
  }, [abn]);

  const v = result && result.checksumValid ? result.verification : null;
  return (
    <div className="abn-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} inputMode="numeric" autoComplete="off" maxLength={14} value={value} onChange={e => onChange(e.target.value)}
        aria-invalid={live.state === "invalid"} aria-describedby={`${id}-status`} />
      <p id={`${id}-status`} className="muted" role="status" aria-live="polite">
        {live.state === "invalid" && <span role="alert">{live.message}</span>}
        {live.state === "incomplete" && live.message}
        {live.state === "valid" && !v && !note && (busy ? "Checksum valid. Checking the register…" : live.message)}
        {live.state === "valid" && note && `Checksum valid. ${note}`}
        {v?.status === "not_verified" && v.note}
        {v?.status === "not_found" && `Checksum valid. ${v.note}`}
        {v?.status === "verified" && `${formatAbn(abn ?? "")}: ${v.entityName}, ${v.active ? "active" : "not active"}, ${v.gstRegistered === null ? "GST status unknown" : v.gstRegistered ? "registered for GST" : "not registered for GST"}.`}
      </p>
    </div>
  );
}
