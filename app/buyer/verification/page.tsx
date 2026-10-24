"use client";
import { useEffect, useState } from "react";
import type { StepState, VerificationStep } from "../../../src/domain/buyer";

/** Mobile (no SMS provider chosen) and ID upload (not built) fail closed: shown as unavailable, nothing is collected. */
const COPY: Record<VerificationStep, { title: string; text: string; unavailable?: string }> = {
  verify_email: { title: "Verify your email", text: "Sign in with Google to confirm your email address." },
  verify_phone: { title: "Verify your mobile", text: "We confirm your mobile number with a code.", unavailable: "Mobile verification is not available yet." },
  verify_id: { title: "Check your ID and take a selfie", text: "We check your photo ID and match it to a live selfie.", unavailable: "ID upload is not available yet." }
};
const LABEL = { done: "Done", current: "Next step", waiting: "Waiting" } as const;

export default function Verification() {
  const [steps, setSteps] = useState<StepState[]>([]);
  const [next, setNext] = useState<VerificationStep | null>(null);
  const [state, setState] = useState<"loading" | "signedOut" | "notBuyer" | "error" | "ok">("loading");

  useEffect(() => {
    fetch("/api/buyer/verification")
      .then(async r => {
        if (r.status === 401) return setState("signedOut");
        if (r.status === 403) return setState("notBuyer");
        if (!r.ok) return setState("error");
        const d = await r.json();
        setSteps(d.steps); setNext(d.next); setState("ok");
      })
      .catch(() => setState("error"));
  }, []);

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
                {COPY[next].unavailable && <p role="status">{COPY[next].unavailable}</p>}
              </section>}
        </>
      )}
      <h2>Privacy</h2>
      <p>ID documents are deleted 7 days after approval and 30 days after rejection (to be confirmed by our lawyers). We never store your document number.</p>
    </main>
  );
}
