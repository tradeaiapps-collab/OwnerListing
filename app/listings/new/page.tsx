"use client";
import { useState } from "react";

type Result = { allowed: boolean; reasons: string[] } | { error: string };

export default function NewListing() {
  const [result, setResult] = useState<Result | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const res = await fetch("/api/listings/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(Object.fromEntries(f.entries()))
    });
    setResult(await res.json());
  }

  return (
    <main>
      <h1>Publish check</h1>
      <p>Dry run only. Nothing is saved or published.</p>
      <form onSubmit={onSubmit} style={{ display: "grid", gap: 8 }}>
        <input name="title" placeholder="Title" required />
        <input name="address" placeholder="Address" required />
        <select name="jurisdiction" defaultValue="QLD">
          {["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"].map(j => <option key={j}>{j}</option>)}
        </select>
        <select name="transactionType" defaultValue="sale">
          <option value="sale">Sale</option>
          <option value="rent">Rental</option>
        </select>
        <select name="useClass" defaultValue="residential">
          <option value="residential">Residential</option>
          <option value="commercial">Commercial</option>
        </select>
        <select name="ownerUserType" defaultValue="owner">
          <option value="owner">Owner</option>
          <option value="agent">Agent</option>
        </select>
        <button type="submit">Check</button>
      </form>
      {result && "error" in result && <p role="alert">{result.error}</p>}
      {result && "allowed" in result && (
        <section>
          <h2>{result.allowed ? "Can be published" : "Blocked"}</h2>
          <ul>{result.reasons.map(r => <li key={r}>{r}</li>)}</ul>
        </section>
      )}
    </main>
  );
}
