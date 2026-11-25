"use client";
import { useEffect, useState } from "react";
import { loadRoles, switchRole } from "../role-switcher";

/** Shown when a signed-in non-investor opens an investor page: switches to the Investor role when held, otherwise points to Manage roles. */
export default function SwitchToInvestor() {
  const [held, setHeld] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { void loadRoles().then(i => setHeld(i && i.roles.includes("investor") ? true : i ? false : null)); }, []);
  if (held === null) return null;
  if (!held) return <a className="button secondary" href="/settings/roles">Add the Investor role</a>;
  return (
    <>
      <button type="button" className="secondary" disabled={busy} onClick={async () => { setBusy(true); setErr(""); if (!(await switchRole("investor"))) { setBusy(false); setErr("Could not switch. Try again."); } }}>Switch to Investor</button>
      {err && <span role="alert"> {err}</span>}
    </>
  );
}
