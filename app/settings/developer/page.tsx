"use client";
import { useCallback, useEffect, useState } from "react";
import { API_SCOPES, SCOPE_DESCRIPTIONS, type ApiScope } from "../../../src/domain/api-scopes";
import { WEBHOOK_EVENTS } from "../../../src/domain/webhook-events";
import { JSON_HEADERS } from "../../listings/ui";
import "../../styles/settings.css";

interface Key { id: string; publicId: string; name: string; scopes: string[]; lastUsedAt: string | null; revokedAt: string | null }
interface Endpoint { id: string; url: string; events: string[]; active: boolean }
interface Usage { totalCalls: number; errorRate: number; suggestions: { id: string; message: string }[] }

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "never");

export default function DeveloperSettings() {
  const [state, setState] = useState<"loading" | "signedOut" | "denied" | "error" | "ok">("loading");
  const [keys, setKeys] = useState<Key[]>([]);
  const [hooks, setHooks] = useState<Endpoint[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [msg, setMsg] = useState("");
  const [shown, setShown] = useState<{ label: string; value: string } | null>(null);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ApiScope[]>(["listings.read"]);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>(["offer.submitted"]);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");

  const load = useCallback(async () => {
    try {
      const k = await fetch("/api/developer/keys");
      if (k.status === 401) return setState("signedOut");
      if (k.status === 403) return setState("denied");
      if (!k.ok) return setState("error");
      setKeys(((await k.json()) as { keys: Key[] }).keys);
      const w = await fetch("/api/developer/webhooks");
      if (w.ok) setHooks(((await w.json()) as { endpoints: Endpoint[] }).endpoints);
      const u = await fetch("/api/developer/usage");
      if (u.ok) setUsage((await u.json()) as Usage);
      setState("ok");
    } catch { setState("error"); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const send = async (path: string, method: string, body?: unknown) => {
    setMsg("");
    const r = await fetch(path, { method, headers: JSON_HEADERS, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).catch(() => null);
    if (!r) { setMsg("Could not reach the server. Try again."); return null; }
    const d = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) { setMsg(typeof d["error"] === "string" ? d["error"] : "Something went wrong."); return null; }
    return d;
  };
  const toggle = <T extends string>(list: T[], v: T): T[] => (list.includes(v) ? list.filter(x => x !== v) : [...list, v]);

  if (state === "loading") return <main><p className="muted" role="status">Loading…</p></main>;
  if (state === "signedOut") return <main><h1>Developer</h1><p role="alert"><a href="/login?next=/settings/developer">Sign in</a> to manage API access.</p></main>;
  if (state === "denied") return <main><h1>Developer</h1><p role="alert">API access is for owners and agents.</p></main>;
  if (state === "error") return <main><h1>Developer</h1><p role="alert">Could not load your API settings.</p></main>;

  return (
    <main>
      <h1>Developer</h1>
      <p className="muted">Connect your own tools. Read the <a href="/api/v1/openapi">API description</a>, create a key, and subscribe to events.</p>
      {msg ? <p role="alert">{msg}</p> : null}
      {shown ? (
        <div className="dev-card" role="status">
          <strong>{shown.label}. Copy it now: it cannot be shown again.</strong>
          <code className="dev-secret">{shown.value}</code>
          <button type="button" onClick={() => setShown(null)}>I have saved it</button>
        </div>
      ) : null}
      <div className="dev-stack">
        <section className="dev-card" aria-labelledby="keys-h">
          <h2 id="keys-h">API keys</h2>
          {keys.length === 0 ? <p className="dev-empty">No keys yet.</p> : (
            <ul className="dev-list">{keys.map(k => (
              <li key={k.id} className="dev-row">
                <div><strong>{k.name}</strong><br /><code>{k.publicId}</code><br /><span className="muted">{k.scopes.join(", ")} · last used {when(k.lastUsedAt)}{k.revokedAt ? " · revoked" : ""}</span></div>
                {k.revokedAt ? null : <button type="button" onClick={async () => { if (await send(`/api/developer/keys/${k.id}`, "DELETE")) void load(); }}>Revoke</button>}
              </li>))}
            </ul>)}
          <form className="dev-form" onSubmit={async e => {
            e.preventDefault();
            const d = await send("/api/developer/keys", "POST", { name, scopes });
            if (d) { setShown({ label: "New API key", value: String(d["secretKey"]) }); setName(""); void load(); }
          }}>
            <label>Name<input value={name} maxLength={80} required onChange={e => setName(e.target.value)} placeholder="CRM sync" /></label>
            <fieldset className="dev-checks"><legend>Scopes</legend>
              {API_SCOPES.map(s => (
                <label key={s}><input type="checkbox" checked={scopes.includes(s)} onChange={() => setScopes(toggle(scopes, s))} /><span className="dev-check-text">{s}<span className="muted">{SCOPE_DESCRIPTIONS[s]}</span></span></label>))}
            </fieldset>
            <button type="submit" disabled={scopes.length === 0}>Create key</button>
          </form>
        </section>

        <section className="dev-card" aria-labelledby="hooks-h">
          <h2 id="hooks-h">Webhooks</h2>
          {hooks.length === 0 ? <p className="dev-empty">No endpoints yet.</p> : (
            <ul className="dev-list">{hooks.map(h => (
              <li key={h.id} className="dev-row">
                <div><code>{h.url}</code><br /><span className="muted">{h.events.join(", ")}{h.active ? "" : " · disabled after repeated failures"}</span></div>
                <button type="button" onClick={async () => { if (await send(`/api/developer/webhooks/${h.id}`, "DELETE")) void load(); }}>Delete</button>
              </li>))}
            </ul>)}
          <form className="dev-form" onSubmit={async e => {
            e.preventDefault();
            const d = await send("/api/developer/webhooks", "POST", { url, events });
            if (d) { setShown({ label: "Signing secret", value: String(d["secret"]) }); setUrl(""); void load(); }
          }}>
            <label>HTTPS URL<input type="url" value={url} required onChange={e => setUrl(e.target.value)} placeholder="https://example.com/hooks/listings" /></label>
            <fieldset className="dev-checks"><legend>Events</legend>
              {WEBHOOK_EVENTS.map(ev => (
                <label key={ev}><input type="checkbox" checked={events.includes(ev)} onChange={() => setEvents(toggle(events, ev))} /> {ev}</label>))}
            </fieldset>
            <button type="submit" disabled={events.length === 0}>Add endpoint</button>
          </form>
        </section>

        <section className="dev-card" aria-labelledby="elena-h">
          <h2 id="elena-h">Ask Elena</h2>
          {usage && usage.totalCalls > 0 ? (
            <>
              <p>{usage.totalCalls} calls in the last 7 days, {Math.round(usage.errorRate * 100)}% failed.</p>
              {usage.suggestions.length ? <ul>{usage.suggestions.map(s => <li key={s.id}>{s.message}</li>)}</ul> : <p className="dev-empty">Nothing to fix. Your integration looks healthy.</p>}
            </>) : <p className="dev-empty">Once your integration makes calls, I will point out anything worth fixing.</p>}
          <form className="dev-form" onSubmit={async e => {
            e.preventDefault();
            const d = await send("/api/developer/assistant", "POST", { question });
            if (d) setAnswer(String(d["answer"]));
          }}>
            <label>Question about the API<input value={question} maxLength={500} required onChange={e => setQuestion(e.target.value)} placeholder="How do I verify a webhook?" /></label>
            <button type="submit">Ask</button>
          </form>
          {answer ? <p role="status">{answer}</p> : null}
        </section>
      </div>
    </main>
  );
}
