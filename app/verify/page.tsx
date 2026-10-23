"use client";
import { useEffect, useState } from "react";
import { JSON_HEADERS, fieldStyle } from "../listings/ui";
import IdForm from "./IdForm";

interface Status { emailVerified: boolean; phoneVerified: boolean; idVerified: boolean; nextStep: string | null }

export default function Verify() {
  const [status, setStatus] = useState<Status | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [message, setMessage] = useState("");

  async function refresh() {
    const r = await fetch("/api/verify/status");
    if (r.status === 401) return setSignedOut(true);
    if (r.ok) setStatus(await r.json());
  }
  useEffect(() => { void refresh(); }, []);

  async function post(url: string, body: object) {
    const r = await fetch(url, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, error: (data as { error?: string }).error ?? "Something went wrong." };
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setMessage("");
    const r = await post("/api/verify/phone/start", { phone });
    if (r.ok) { setSent(true); setMessage("We sent a 6 digit code by text message."); } else setMessage(r.error);
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    setMessage("");
    const r = await post("/api/verify/phone/confirm", { code });
    if (r.ok) { setSent(false); setCode(""); await refresh(); } else setMessage(r.error);
  }

  if (signedOut) return <main><p role="alert"><a href="/api/auth/google/start">Sign in with Google</a> to verify your account.</p></main>;
  return (
    <main style={{ overflowWrap: "anywhere" }}>
      <h1>Verify your account</h1>
      <p>You need a verified email, mobile and ID before you can contact a seller.</p>
      {status && (
        <ul>
          <li>Email: {status.emailVerified ? "verified" : "not verified"}</li>
          <li>Mobile: {status.phoneVerified ? "verified" : "not verified"}</li>
          <li>ID: {status.idVerified ? "verified" : "not verified"}</li>
        </ul>
      )}
      {message && <p role="alert">{message}</p>}
      {status && !status.phoneVerified && !sent && (
        <form onSubmit={send} style={{ display: "grid", gap: 8, maxWidth: 420 }}>
          <label>Australian mobile number
            <input style={fieldStyle} inputMode="tel" autoComplete="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="0412 345 678" required />
          </label>
          <button type="submit">Send code</button>
        </form>
      )}
      {status && !status.phoneVerified && sent && (
        <form onSubmit={confirm} style={{ display: "grid", gap: 8, maxWidth: 420 }}>
          <label>6 digit code
            <input style={fieldStyle} inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={e => setCode(e.target.value)} required />
          </label>
          <button type="submit">Confirm</button>
        </form>
      )}
      {status && !status.idVerified && <IdForm onDone={refresh} />}
    </main>
  );
}
