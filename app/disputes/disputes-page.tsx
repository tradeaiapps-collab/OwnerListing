"use client";
import { useEffect, useState } from "react";
import { DisputeList, type Summary } from "./dispute-parts";

/** A person's disputes on one side of their sales (as buyer or as owner), the ones waiting on them first. */
export default function DisputesPage({ side, intro }: { side: "buyer" | "seller"; intro: string }) {
  const [rows, setRows] = useState<Summary[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    fetch(`/api/disputes?side=${side}`)
      .then(async r => { const d = await r.json().catch(() => ({})); if (r.ok) setRows(d.disputes); else setError(r.status === 401 ? "Sign in to see your disputes." : d.error ?? "Could not load your disputes."); })
      .catch(() => setError("Could not load your disputes."));
  }, [side]);
  const waiting = rows?.filter(r => r.yourTurn).length ?? 0;
  return (
    <main>
      <h1>Your disputes</h1>
      <p>{intro}</p>
      {error ? <p role="alert">{error}</p> : null}
      {!error && rows === null ? <p className="muted" role="status">Loading…</p> : null}
      {waiting > 0 ? <p role="status"><strong>{waiting} {waiting === 1 ? "dispute is" : "disputes are"} waiting for you.</strong></p> : null}
      {rows ? <DisputeList rows={rows} empty="No disputes. If you and the other side disagree during settlement, you can raise it from the settlement page." /> : null}
      <p><a href="/settlements">Go to your settlements</a></p>
    </main>
  );
}
