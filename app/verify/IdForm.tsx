"use client";
import { useState } from "react";
import { fieldStyle } from "../listings/ui";

export default function IdForm({ onDone }: { onDone: () => void }) {
  const [kind, setKind] = useState("drivers_licence");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setMessage("");
    setBusy(true);
    const fd = new FormData(e.currentTarget);
    // The selfie field asks the phone camera directly. The server cannot prove it, so reviewers still judge it.
    fd.set("selfieCapturedInApp", "true");
    const r = await fetch("/api/verify/id", { method: "POST", body: fd });
    setBusy(false);
    if (r.ok) { setMessage("Submitted. We will review it and update your status."); onDone(); }
    else setMessage(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Could not submit.");
  }

  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 8, maxWidth: 420 }}>
      <h2>ID check</h2>
      {message && <p role="alert">{message}</p>}
      <label>Document type
        <select name="documentKind" value={kind} onChange={e => setKind(e.target.value)} style={fieldStyle}>
          <option value="drivers_licence">Driver licence</option><option value="passport">Passport</option><option value="other_government_id">Other government ID</option>
        </select>
      </label>
      <label>Issuing country (2 letters)<input name="documentCountry" defaultValue="AU" maxLength={2} required style={fieldStyle} /></label>
      <label>Expiry date<input name="expiryDate" type="date" required style={fieldStyle} /></label>
      <label>{kind === "passport" ? "Photo page" : "Front of document"}<input name="front" type="file" accept="image/jpeg,image/png" required /></label>
      {kind !== "passport" && <label>Back of document<input name="back" type="file" accept="image/jpeg,image/png" required /></label>}
      <label>Selfie<input name="selfie" type="file" accept="image/jpeg,image/png" capture="user" required /></label>
      <p><small>Images are kept privately, only reviewed by our staff, and deleted after the check. We do not store your document number.</small></p>
      <button type="submit" disabled={busy}>Submit for review</button>
    </form>
  );
}
