"use client";
import { useEffect, useState } from "react";
import { safeNext } from "../../src/server/auth/safe-next";
import { JSON_HEADERS } from "../listings/ui";
import "../styles/settings.css";

type Kind = "totp" | "sms";
interface Status {
  required: boolean; enrolled: boolean; verified: boolean; recent: boolean;
  available: { totp: boolean; sms: boolean };
  methods: { id: string; kind: Kind; label: string; addedAt: string }[];
  recoveryCodesLeft: number;
  smsConsentText: string;
}
type Setup = { kind: "totp"; secret: string; otpauthUri: string } | { kind: "sms"; sent: boolean };

async function call(url: string, method: string, body?: unknown): Promise<{ ok: boolean; status: number; d: Record<string, unknown> }> {
  const r = await fetch(url, { method, headers: JSON_HEADERS, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }).catch(() => null);
  if (!r) return { ok: false, status: 0, d: { error: "Check your connection and try again." } };
  return { ok: r.ok, status: r.status, d: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}
const errorOf = (d: Record<string, unknown>, fallback: string) => (typeof d["error"] === "string" ? d["error"] : fallback);

/**
 * The second sign-in step. Sets up an authenticator app or text-message codes, checks a code at sign-in or before a sensitive action
 * (publish, accept an offer), and manages methods and recovery codes. Every rule is enforced on the server; this page only asks.
 */
export default function Mfa() {
  const [status, setStatus] = useState<Status | null | "signedOut" | "error">(null);
  const [next, setNext] = useState<string | undefined>();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [method, setMethod] = useState<Kind | "recovery">("totp");
  const [code, setCode] = useState("");
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => fetch("/api/auth/mfa/status").then(async r => {
    if (r.status === 401) return setStatus("signedOut");
    if (!r.ok) return setStatus("error");
    const s = (await r.json()) as Status;
    setStatus(s);
    setMethod(m => (s.methods.some(x => x.kind === m) ? m : s.methods[0]?.kind ?? "totp"));
  }).catch(() => setStatus("error"));

  useEffect(() => {
    setNext(safeNext(new URLSearchParams(window.location.search).get("next")));
    void load();
  }, []);

  const done = () => window.location.assign(next ?? "/dashboard");
  const run = async (fn: () => Promise<void>) => { setBusy(true); setMsg(""); try { await fn(); } finally { setBusy(false); } };

  const startTotp = () => run(async () => {
    const r = await call("/api/auth/mfa/totp/setup", "POST");
    if (r.ok) { setSetup({ kind: "totp", secret: String(r.d["secret"]), otpauthUri: String(r.d["otpauthUri"]) }); setCode(""); }
    else setMsg(errorOf(r.d, "Could not start the set-up."));
  });
  const startSms = (e: React.FormEvent) => { e.preventDefault(); void run(async () => {
    const r = await call("/api/auth/mfa/sms/setup", "POST", { phone, consent });
    if (r.ok) { setSetup({ kind: "sms", sent: true }); setCode(""); setMsg("Code sent. It expires in 10 minutes."); }
    else setMsg(errorOf(r.d, "Could not send the code."));
  }); };
  const confirm = (e: React.FormEvent) => { e.preventDefault(); if (!setup) return; void run(async () => {
    const r = await call(`/api/auth/mfa/${setup.kind}/confirm`, "POST", { code });
    if (!r.ok) return setMsg(errorOf(r.d, "Could not confirm the code."));
    setSetup(null); setCode("");
    if (Array.isArray(r.d["recoveryCodes"])) setCodes(r.d["recoveryCodes"].map(String));
    else if (next) return done();
    await load();
  }); };
  const sendSignInCode = () => run(async () => {
    const r = await call("/api/auth/mfa/sms/send", "POST");
    setMsg(r.ok ? "Code sent. It expires in 10 minutes." : errorOf(r.d, "Could not send the code."));
  });
  const verify = (e: React.FormEvent) => { e.preventDefault(); void run(async () => {
    const r = await call("/api/auth/mfa/verify", "POST", { method, code });
    if (!r.ok) return setMsg(errorOf(r.d, "Could not check the code."));
    setCode("");
    if (method === "recovery" && Number(r.d["recoveryCodesLeft"]) <= 3) {
      setMsg(`You have ${Number(r.d["recoveryCodesLeft"])} recovery codes left. Make a new set below.`);
      return void load();
    }
    if (next) return done();
    await load();
  }); };
  const remove = (id: string) => run(async () => {
    const r = await call(`/api/auth/mfa/methods/${encodeURIComponent(id)}`, "DELETE");
    if (r.status === 403 && r.d["code"] === "mfa_required") { setMsg("Confirm it's you again first."); return void load(); }
    setMsg(r.ok ? "Removed." : errorOf(r.d, "Could not remove it."));
    await load();
  });
  const regenerate = () => run(async () => {
    const r = await call("/api/auth/mfa/recovery-codes", "POST");
    if (r.status === 403 && r.d["code"] === "mfa_required") { setMsg("Confirm it's you again first."); return void load(); }
    if (r.ok && Array.isArray(r.d["recoveryCodes"])) setCodes(r.d["recoveryCodes"].map(String));
    else setMsg(errorOf(r.d, "Could not make new codes."));
  });

  if (status === null) return <main><p className="muted" role="status">Loading…</p></main>;
  if (status === "signedOut") return <main><h1>Two-step sign-in</h1><p role="alert"><a href="/api/auth/google/start?next=/mfa">Sign in</a> first.</p></main>;
  if (status === "error") return <main><h1>Two-step sign-in</h1><p role="alert">Could not load your sign-in settings. Try again shortly.</p></main>;

  const note = msg ? <p role="status">{msg}</p> : null;

  if (codes) {
    return (
      <main>
        <h1>Save your recovery codes</h1>
        <p>If you lose your phone, each code below lets you sign in once. Keep them somewhere safe, such as a password manager. They are shown only now.</p>
        <ul className="terms-box" aria-label="Recovery codes" style={{ fontFamily: "monospace", columns: 2 }}>{codes.map(c => <li key={c}>{c}</li>)}</ul>
        <p><button type="button" onClick={() => { void navigator.clipboard?.writeText(codes.join("\n")).then(() => setMsg("Copied."), () => setMsg("Copy failed. Select the codes and copy them.")); }}>Copy codes</button></p>
        {note}
        <p><button type="button" onClick={() => { setCodes(null); if (next) done(); else void load(); }}>I have saved them</button></p>
      </main>
    );
  }

  const needCheck = status.enrolled && (!status.verified || (next !== undefined && !status.recent));
  if (needCheck) {
    const kinds = status.methods.map(m => m.kind);
    return (
      <main>
        <h1>Confirm it&apos;s you</h1>
        <p>{status.verified ? "This action needs a fresh check." : "Your account uses two-step sign-in."} Enter a code from {kinds.includes("totp") ? "your authenticator app" : "the text message we send you"}.</p>
        <form className="settings-form" onSubmit={verify}>
          <label>
            Method
            <select value={method} onChange={e => { setMethod(e.target.value as Kind | "recovery"); setCode(""); setMsg(""); }}>
              {kinds.includes("totp") && <option value="totp">Authenticator app</option>}
              {kinds.includes("sms") && <option value="sms">Text message</option>}
              <option value="recovery">Recovery code</option>
            </select>
          </label>
          {method === "sms" && <button type="button" className="secondary" onClick={sendSignInCode} disabled={busy}>Text me a code</button>}
          <label>
            {method === "recovery" ? "Recovery code" : "6-digit code"}
            <input value={code} onChange={e => setCode(e.target.value)} autoComplete="one-time-code" inputMode={method === "recovery" ? "text" : "numeric"} required
              {...(method === "recovery" ? { maxLength: 14 } : { maxLength: 7, pattern: "\\d{6}" })} />
          </label>
          {note}
          <button type="submit" disabled={busy}>{busy ? "Checking…" : "Continue"}</button>
        </form>
      </main>
    );
  }

  const canAdd = (k: Kind) => status.available[k] && !status.methods.some(m => m.kind === k);
  return (
    <main>
      <h1>Two-step sign-in</h1>
      {!status.enrolled ? (
        <p>{status.required ? "Owner and agent accounts need a second step after Google sign-in. Set one up to continue." : "Add a second step after Google sign-in to protect your account."}</p>
      ) : (
        <>
          <p>After Google sign-in you also confirm it&apos;s you with:</p>
          <ul>
            {status.methods.map(m => (
              <li key={m.id}>{m.label} <button type="button" className="secondary" onClick={() => void remove(m.id)} disabled={busy}>Remove</button></li>
            ))}
          </ul>
          <p>Recovery codes left: {status.recoveryCodesLeft}. <button type="button" className="secondary" onClick={() => void regenerate()} disabled={busy}>Make new recovery codes</button></p>
          {next && <p><a href={next}>Continue</a></p>}
        </>
      )}
      {!status.available.totp && !status.enrolled && <p role="alert">Two-step sign-in is not available yet. Try again later.</p>}

      {setup?.kind === "totp" ? (
        <form className="settings-form" onSubmit={confirm}>
          <p>Add this account to an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password and others). On this phone you can <a href={setup.otpauthUri}>open it in the app</a>; otherwise enter this key:</p>
          <p style={{ fontFamily: "monospace", wordBreak: "break-all" }}>{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</p>
          <label>
            Code shown in the app
            <input value={code} onChange={e => setCode(e.target.value)} autoComplete="one-time-code" inputMode="numeric" maxLength={7} required />
          </label>
          {note}
          <button type="submit" disabled={busy}>Confirm</button>
        </form>
      ) : setup?.kind === "sms" ? (
        <form className="settings-form" onSubmit={confirm}>
          <label>
            Code we texted you
            <input value={code} onChange={e => setCode(e.target.value)} autoComplete="one-time-code" inputMode="numeric" maxLength={7} required />
          </label>
          {note}
          <button type="submit" disabled={busy}>Confirm</button>
        </form>
      ) : (
        <>
          {canAdd("totp") && (
            <section>
              <h2>Authenticator app (recommended)</h2>
              <p>Works without phone signal and cannot be intercepted like a text message.</p>
              <button type="button" onClick={() => void startTotp()} disabled={busy}>Set up an authenticator app</button>
            </section>
          )}
          {canAdd("sms") && (
            <section>
              <h2>Text message</h2>
              <form className="settings-form" onSubmit={startSms}>
                <label>
                  Australian mobile number
                  <input value={phone} onChange={e => setPhone(e.target.value)} inputMode="tel" autoComplete="tel" placeholder="0400 000 000" required />
                </label>
                <label className="terms-check">
                  <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} required />
                  {status.smsConsentText}
                </label>
                <button type="submit" disabled={busy}>Text me a code</button>
              </form>
            </section>
          )}
          {note}
        </>
      )}
    </main>
  );
}
