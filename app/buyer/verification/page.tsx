"use client";
import { useEffect, useState, type ChangeEvent } from "react";
import type { StepState, VerificationStep } from "../../../src/domain/buyer";

/**
 * Mobile and ID forms show "not available yet" only while their port reports unconfigured; nothing is collected then.
 * ID: our own reviewers (photo upload) when image storage is configured, otherwise the provider check if one is wired in.
 */
const COPY: Record<VerificationStep, { title: string; text: string }> = {
  verify_email: { title: "Verify your email", text: "Sign in with Google to confirm your email address." },
  verify_phone: { title: "Verify your mobile", text: "We confirm your mobile number with a code." },
  verify_id: { title: "Check your ID and take a selfie", text: "We check your Australian government photo ID against a live selfie." }
};
const NOT_YET = { verify_phone: "Mobile verification is not available yet.", verify_id: "ID check is not available yet." } as const;

async function post(url: string, body?: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { ok: r.ok, data: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

function PhoneForm({ consentText, onDone }: { consentText: string; onDone: () => void }) {
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => { setBusy(true); setMsg(""); try { await fn(); } catch { setMsg("Something went wrong. Try again."); } setBusy(false); };
  const send = () => run(async () => {
    const r = await post("/api/buyer/verification/phone/send", { phone, consent });
    if (r.ok) { setSent(true); setMsg("We sent a 6-digit code. It expires in 10 minutes."); } else setMsg(String(r.data["error"] ?? "Could not send the code."));
  });
  const verify = () => run(async () => {
    const r = await post("/api/buyer/verification/phone/verify", { code });
    if (r.ok) onDone(); else setMsg(String(r.data["error"] ?? "That code did not work."));
  });
  return (
    <div>
      <label>Australian mobile number <input type="tel" autoComplete="tel" inputMode="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="0400 000 000" /></label>
      <label><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} /> {consentText}</label>
      <button type="button" disabled={busy || !consent || phone.trim() === ""} onClick={send}>{sent ? "Send a new code" : "Text me a code"}</button>
      {sent && (
        <>
          <label>6-digit code <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ""))} /></label>
          <button type="button" disabled={busy || code.length !== 6} onClick={verify}>Verify</button>
        </>
      )}
      {msg && <p role="status">{msg}</p>}
    </div>
  );
}

function IdForm() {
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true); setMsg("");
    try {
      const r = await post("/api/buyer/verification/id/start");
      const url = r.data["redirectUrl"];
      if (r.ok && typeof url === "string" && url.startsWith("https://")) { window.location.assign(url); return; }
      setMsg(String(r.data["error"] ?? "Could not start the ID check."));
    } catch { setMsg("Something went wrong. Try again."); }
    setBusy(false);
  };
  return (
    <div>
      <button type="button" disabled={busy} onClick={start}>Start ID check</button>
      {msg && <p role="status">{msg}</p>}
    </div>
  );
}
type IdConsent = { text: string; version: string };
const REVIEW_MSG: Record<string, string> = {
  pending: "Your ID is waiting for review. We will update this page when a reviewer has checked it.",
  rejected: "Your last ID check was not approved. You can try again with clear photos.",
  needs_more: "Our reviewer needs clearer photos. Please try again."
};

/** Photos go straight to our server (encrypted there). The phone opens the camera for each photo; nothing is kept in the browser. */
function IdPhotoForm({ consent, onDone }: { consent: IdConsent; onDone: () => void }) {
  const [agreed, setAgreed] = useState(false);
  const [kind, setKind] = useState("drivers_licence");
  const [expiry, setExpiry] = useState("");
  const [files, setFiles] = useState<Record<string, File | null>>({ front: null, back: null, selfie: null });
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const needsBack = kind !== "passport";
  const ready = agreed && expiry !== "" && files["front"] && files["selfie"] && (!needsBack || files["back"]);
  const pick = (part: string) => (e: ChangeEvent<HTMLInputElement>) => setFiles({ ...files, [part]: e.target.files?.[0] ?? null });
  const submit = async () => {
    setBusy(true); setMsg("");
    try {
      const fd = new FormData();
      fd.set("consent", "true"); fd.set("consentVersion", consent.version);
      fd.set("documentKind", kind); fd.set("documentCountry", "AU"); fd.set("expiryDate", expiry); fd.set("selfieSource", "camera");
      for (const p of needsBack ? ["front", "back", "selfie"] : ["front", "selfie"]) fd.set(p, files[p]!);
      const r = await fetch("/api/buyer/verification/id/images", { method: "POST", body: fd });
      const d = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (r.ok) { onDone(); return; }
      setMsg(String(d["error"] ?? "Could not send the photos."));
    } catch { setMsg("Something went wrong. Try again."); }
    setBusy(false);
  };
  return (
    <div>
      <h3>Privacy notice</h3>
      <p>{consent.text}</p>
      <label><input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} /> I have read the privacy notice and agree.</label>
      {agreed && (
        <>
          <label>Type of ID
            <select value={kind} onChange={e => setKind(e.target.value)}>
              <option value="drivers_licence">Australian driver licence</option>
              <option value="passport">Australian passport</option>
              <option value="other_government_id">Other Australian government photo ID (for example a proof-of-age card)</option>
            </select>
          </label>
          <label>Expiry date <input type="date" value={expiry} onChange={e => setExpiry(e.target.value)} /></label>
          <label>{needsBack ? "Photo of the front" : "Photo of the photo page"} <input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={pick("front")} /></label>
          {needsBack && <label>Photo of the back <input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={pick("back")} /></label>}
          <label>Selfie (take it now with your front camera) <input type="file" accept="image/jpeg,image/png,image/webp" capture="user" onChange={pick("selfie")} /></label>
          <p className="muted">Do not type your document number anywhere: we never record it. Location and camera details are removed from the photos.</p>
          <button type="button" disabled={busy || !ready} onClick={submit}>Send for review</button>
        </>
      )}
      {msg && <p role="status">{msg}</p>}
    </div>
  );
}

const LABEL = { done: "Done", current: "Next step", waiting: "Waiting" } as const;

export default function Verification() {
  const [steps, setSteps] = useState<StepState[]>([]);
  const [next, setNext] = useState<VerificationStep | null>(null);
  const [state, setState] = useState<"loading" | "signedOut" | "notBuyer" | "error" | "ok">("loading");
  const [available, setAvailable] = useState({ phone: false, id: false, idImages: false });
  const [consentText, setConsentText] = useState("");
  const [idConsent, setIdConsent] = useState<IdConsent | null>(null);
  const [idReview, setIdReview] = useState<string | null>(null);

  const load = () => {
    fetch("/api/buyer/verification")
      .then(async r => {
        if (r.status === 401) return setState("signedOut");
        if (r.status === 403) return setState("notBuyer");
        if (!r.ok) return setState("error");
        const d = await r.json();
        const o = await fetch("/api/buyer/verification/options").then(x => (x.ok ? x.json() : null)).catch(() => null);
        setAvailable({ phone: o?.available?.phone === true, id: o?.available?.id === true, idImages: o?.available?.idImages === true });
        setConsentText(typeof o?.smsConsentText === "string" ? o.smsConsentText : "");
        const c = o?.idImageConsent;
        setIdConsent(typeof c?.text === "string" && typeof c?.version === "string" ? { text: c.text, version: c.version } : null);
        if (o?.available?.idImages === true) {
          const st = await fetch("/api/buyer/verification/id/images").then(x => (x.ok ? x.json() : null)).catch(() => null);
          setIdReview(typeof st?.status === "string" ? st.status : null);
        }
        setSteps(d.steps); setNext(d.next); setState("ok");
      })
      .catch(() => setState("error"));
  };
  useEffect(load, []);

  return (
    <main>
      <h1>Verification</h1>
      <p>You verify once. We reuse the result every time you contact a seller, make an offer or apply for a rental.</p>
      {state === "loading" && <p>Loading…</p>}
      {state === "signedOut" && <p role="alert"><a href="/api/auth/google/start?as=buyer&next=/buyer/verification">Sign in with Google</a> to see your verification.</p>}
      {state === "notBuyer" && <p role="alert">Verification is for buyer accounts.</p>}
      {state === "error" && <p role="alert">Could not load your verification.</p>}
      {state === "ok" && (
        <>
          <ol className="card-list">
            {steps.map(s => (
              <li key={s.step}><strong>{COPY[s.step].title}</strong> <span>({LABEL[s.status]})</span></li>
            ))}
          </ol>
          {next === null
            ? <p>You are fully verified.</p>
            : <section aria-live="polite">
                <h2>{COPY[next].title}</h2>
                <p>{COPY[next].text}</p>
                {next === "verify_phone" && (available.phone && consentText ? <PhoneForm consentText={consentText} onDone={load} /> : <p role="status">{NOT_YET.verify_phone}</p>)}
                {next === "verify_id" && (available.idImages && idConsent
                  ? (idReview === "pending" ? <p role="status">{REVIEW_MSG["pending"]}</p> : <>
                      {idReview && REVIEW_MSG[idReview] && <p role="status">{REVIEW_MSG[idReview]}</p>}
                      <IdPhotoForm consent={idConsent} onDone={load} />
                    </>)
                  : available.id ? <IdForm /> : <p role="status">{NOT_YET.verify_id}</p>)}
              </section>}
        </>
      )}
      <h2>Privacy</h2>
      <p>ID documents are deleted 7 days after approval and 30 days after rejection (to be confirmed by our lawyers). We never store your document number. ID photos you send us are encrypted, seen only by the staff member reviewing your check, and you cannot download them again from this site. We keep your verified mobile number and the result of your ID check. We send one text message with a code, only after you agree.</p>
    </main>
  );
}
