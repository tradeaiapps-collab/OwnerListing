"use client";
import { useEffect, useState } from "react";
import { send, STEP_LINK } from "../ui";

type Status = {
  steps: { step: string; status: string }[]; next: string | null; category: string | null;
  disclosure: { version: string; text: string }; acknowledgements: Record<string, string>;
};
const STEP_NAME: Record<string, string> = { verify_email: "Email", verify_phone: "Mobile", verify_id: "ID check" };
const CATEGORIES: [string, string][] = [
  ["wholesale", "Wholesale investor (for example, I meet the net assets or income test and hold an accountant's certificate)"],
  ["sophisticated", "Sophisticated investor (assessed by a licensed adviser)"],
  ["retail", "Retail investor (none of the above)"]
];

/** Investor onboarding: buyer verification steps, then a self-declaration and acknowledgements against the current risk warning. */
export default function InvestorOnboarding() {
  const [s, setS] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [step, setStep] = useState("");
  const [note, setNote] = useState("");

  const load = () => fetch("/api/investments/investor").then(async r => {
    const d = await r.json().catch(() => ({}));
    if (r.ok) setS(d); else { setError(r.status === 401 ? "Sign in with an investor (buyer) account." : d.error ?? "Could not load."); setStep(d.step ?? ""); }
  }).catch(() => setError("Could not load."));
  useEffect(() => { void load(); }, []);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(""); setNote("");
    const fd = new FormData(e.currentTarget);
    const acknowledgements = Object.fromEntries(Object.keys(s!.acknowledgements).map(k => [k, fd.get(k) === "on"]));
    const r = await send("/api/investments/investor/declaration", "POST", { category: fd.get("category"), acknowledgements, disclosureVersion: s!.disclosure.version });
    if (r.ok) { setNote("Declaration saved."); await load(); } else setError(String(r.data["error"] ?? "Could not save."));
  }

  const link = STEP_LINK[step];
  return (
    <main>
      <h1>Investor declaration</h1>
      {error && <p role="alert">{error} {link && <a href={link[0]}>{link[1]}</a>}</p>}
      {s && (
        <>
          <ol className="card-list">{s.steps.map(x => <li key={x.step}>{STEP_NAME[x.step]}: {x.status}</li>)}</ol>
          {s.next && s.next !== "declare" && <p><a href="/buyer/verification">Finish verification first</a></p>}
          {s.category && s.next === null && <p className="staff-notice">You declared: {s.category}. <a href="/investments">Browse projects</a></p>}
          <form className="inv-form" onSubmit={submit}>
            <fieldset disabled={s.next !== null && s.next !== "declare"}>
              <legend>Which describes you?</legend>
              {CATEGORIES.map(([v, l]) => <label key={v} className="inv-check"><input type="radio" name="category" value={v} required defaultChecked={s.category === v} />{l}</label>)}
              <p className="muted">This is your own statement. Retail investors only see projects open to all verified investors. Counsel will confirm what evidence is needed.</p>
            </fieldset>
            <fieldset disabled={s.next !== null && s.next !== "declare"}>
              <legend>I acknowledge</legend>
              {Object.entries(s.acknowledgements).map(([k, l]) => <label key={k} className="inv-check"><input type="checkbox" name={k} required />{l}</label>)}
            </fieldset>
            <button type="submit" disabled={s.next !== null && s.next !== "declare"}>Save declaration</button>
          </form>
        </>
      )}
      {note && <p role="status">{note}</p>}
    </main>
  );
}
