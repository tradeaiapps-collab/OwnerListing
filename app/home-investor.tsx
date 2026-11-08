"use client";
import { useEffect, useState } from "react";

/** Home page entry to Investor projects. Same fail-closed rule as the header link: renders nothing unless /api/investments/status says the module is live. */
export default function HomeInvestor() {
  const [state, setState] = useState<{ title: string; text: string } | null>(null);
  useEffect(() => {
    fetch("/api/investments/status").then(r => (r.ok ? r.json() : null)).then(s => {
      if (s?.live === true && s.disclosure) setState({ title: String(s.disclosure.title), text: String(s.disclosure.text) });
    }).catch(() => null);
  }, []);
  if (!state) return null;
  return (
    <section className="home-sec home-alt" aria-labelledby="home-invest-t" data-crumb="Investor projects">
      <div className="home-wrap">
        <p className="eyebrow">Projects</p>
        <h2 id="home-invest-t">Investor projects</h2>
        <p>Owners post property projects here. Browse them, then deal directly with the owner through your own advisers.</p>
        <a className="button secondary" href="/investments">Browse investor projects</a>
        <p className="muted home-invest-note"><strong>{state.title}.</strong> {state.text}</p>
      </div>
    </section>
  );
}
