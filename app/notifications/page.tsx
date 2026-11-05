"use client";
import { useCallback, useEffect, useState } from "react";
import { CATEGORIES, CHANNELS, type Category, type Channel, type ElenaReply, type NotificationView, type Preferences } from "../../src/domain/notifications";
import { JSON_HEADERS } from "../listings/ui";
import "../styles/notifications.css";

type Tab = "inbox" | "history" | "preferences";
interface CategoryRow { category: Category; label: string; text: string; locked: Channel[]; smsAllowed: boolean }
interface Suggestion { category: Category; channel: Channel; turnOn: boolean; reason: string }
const CHANNEL_LABEL: Record<Channel, string> = { inApp: "In-app", email: "Email", sms: "Text" };

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const api = (url: string, method: string, body?: unknown) => fetch(url, { method, headers: JSON_HEADERS, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).catch(() => null);

export default function Notifications() {
  const [state, setState] = useState<"loading" | "signedOut" | "error" | "ok">("loading");
  const [tab, setTab] = useState<Tab>("inbox");
  const [items, setItems] = useState<NotificationView[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const [listState, setListState] = useState<"loading" | "error" | "ok">("loading");
  const [msg, setMsg] = useState("");

  const load = useCallback(async (which: "inbox" | "history", before?: string) => {
    setListState("loading");
    const r = await fetch(`/api/notifications?status=${which}${before ? `&before=${encodeURIComponent(before)}` : ""}`).catch(() => null);
    if (!r) { setListState("error"); setState(s => (s === "loading" ? "error" : s)); return; }
    if (r.status === 401) return setState("signedOut");
    if (!r.ok) { setListState("error"); setState(s => (s === "loading" ? "error" : s)); return; }
    const d = (await r.json()) as { notifications: NotificationView[]; nextBefore: string | null; unread: number };
    setItems(prev => (before ? [...prev, ...d.notifications] : d.notifications));
    setNext(d.nextBefore); setUnread(d.unread); setListState("ok"); setState("ok");
  }, []);

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t === "history" || t === "preferences") setTab(t);
  }, []);
  useEffect(() => { void load(tab === "history" ? "history" : "inbox"); }, [tab, load]);

  const choose = (t: Tab) => { setTab(t); setMsg(""); window.history.replaceState(null, "", t === "inbox" ? "/notifications" : `/notifications?tab=${t}`); };

  const mark = async (url: string, body: unknown, ok: string) => {
    const r = await api(url, "POST", body);
    setMsg(r?.ok ? ok : "That did not work. Try again.");
    if (r?.ok) await load(tab === "history" ? "history" : "inbox");
  };
  const clearHistory = async () => {
    if (!window.confirm("Delete all of your notification history? This cannot be undone.")) return;
    const r = await api("/api/notifications", "DELETE");
    setMsg(r?.ok ? "History deleted." : "Could not delete your history.");
    if (r?.ok) await load("history");
  };

  if (state === "loading") return <main><p className="muted" role="status">Loading…</p></main>;
  if (state === "signedOut") return <main><h1>Notifications</h1><p role="alert"><a href="/login?next=/notifications">Sign in</a> to see your notifications.</p></main>;
  if (state === "error") return <main><h1>Notifications</h1><p role="alert">Could not load your notifications. <button type="button" onClick={() => void load("inbox")}>Try again</button></p></main>;

  return (
    <main>
      <h1>Notifications</h1>
      <div className="nt-layout">
        <section aria-label="Notifications">
          <div className="nt-tabs" role="tablist" aria-label="Notification views">
            {(["inbox", "history", "preferences"] as const).map(t => (
              <button key={t} type="button" role="tab" id={`tab-${t}`} aria-selected={tab === t} aria-controls="nt-panel" onClick={() => choose(t)}>
                {t === "inbox" ? "Inbox" : t === "history" ? "History" : "Settings"}
                {t === "inbox" && unread > 0 ? <span className="nt-badge" aria-label={`${unread} unread`}>{unread}</span> : null}
              </button>
            ))}
          </div>
          <div id="nt-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
            {msg ? <p role="status">{msg}</p> : null}
            {tab === "preferences" ? <Prefs onMessage={setMsg} /> : (
              <>
                <div className="nt-toolbar">
                  {tab === "inbox" ? (<>
                    <button type="button" className="button" disabled={unread === 0} onClick={() => void mark("/api/notifications/read", { all: true }, "All marked as read.")}>Mark all as read</button>
                    <button type="button" className="button" onClick={() => void mark("/api/notifications/archive", { all: true }, "Read notifications moved to history.")}>Move read to history</button>
                  </>) : <button type="button" className="button" disabled={items.length === 0} onClick={() => void clearHistory()}>Delete history</button>}
                </div>
                {listState === "error" ? <p role="alert">Could not load. <button type="button" onClick={() => void load(tab === "history" ? "history" : "inbox")}>Try again</button></p> : null}
                {listState === "ok" && items.length === 0 ? <p className="nt-empty">{tab === "inbox" ? "You have no notifications." : "Your history is empty."}</p> : null}
                <ul className="nt-list">
                  {items.map(n => (
                    <li key={n.id} className="nt-item" data-unread={n.readAt === null}>
                      <span className="nt-dot" aria-hidden="true" />
                      <div>
                        <span className="nt-tag">{n.category}</span>
                        <h3>{n.title}{n.readAt === null ? <span className="sr-only"> (unread)</span> : null}</h3>
                        <p>{n.body}</p>
                        <div className="nt-actions">
                          {n.link ? <a href={n.link} onClick={() => { if (n.readAt === null) void api("/api/notifications/read", "POST", { ids: [n.id] }); }}>Open</a> : null}
                          {n.readAt === null ? <button type="button" onClick={() => void mark("/api/notifications/read", { ids: [n.id] }, "Marked as read.")}>Mark as read</button> : null}
                          {n.archivedAt === null ? <button type="button" onClick={() => void mark("/api/notifications/archive", { ids: [n.id] }, "Moved to history.")}>Move to history</button> : null}
                        </div>
                      </div>
                      <time className="nt-meta" dateTime={n.createdAt}>{when(n.createdAt)}</time>
                    </li>
                  ))}
                </ul>
                {next ? <p><button type="button" className="button nt-more" onClick={() => void load(tab === "history" ? "history" : "inbox", next)}>Show older</button></p> : null}
              </>
            )}
          </div>
        </section>
        <Elena onGoSettings={() => choose("preferences")} />
      </div>
    </main>
  );
}

function Prefs({ onMessage }: { onMessage: (m: string) => void }) {
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [cats, setCats] = useState<CategoryRow[]>([]);
  const [phone, setPhone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);

  useEffect(() => {
    fetch("/api/notifications/preferences").then(async r => {
      if (!r.ok) return setErr(true);
      const d = (await r.json()) as { preferences: Preferences; categories: CategoryRow[]; phoneVerified: boolean };
      setPrefs(d.preferences); setCats(d.categories); setPhone(d.phoneVerified);
    }).catch(() => setErr(true));
  }, []);

  if (err) return <p role="alert">Could not load your settings.</p>;
  if (!prefs) return <p className="muted" role="status">Loading…</p>;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); onMessage("");
    const r = await api("/api/notifications/preferences", "PUT", { preferences: prefs });
    setBusy(false);
    if (!r) return onMessage("Could not save. Check your connection and try again.");
    const d = (await r.json().catch(() => ({}))) as { error?: string; preferences?: Preferences };
    if (r.ok && d.preferences) setPrefs(d.preferences);
    onMessage(r.ok ? "Saved." : d.error ?? "Could not save.");
  };
  const set = (c: Category, ch: Channel, v: boolean) => setPrefs({ ...prefs, [c]: { ...prefs[c], [ch]: v } });

  return (
    <form className="nt-prefs" onSubmit={save}>
      <p className="muted">Choose how you hear about each kind of event. Text messages and news are off until you turn them on, and you can change your mind at any time. We keep a record of each change.</p>
      <table>
        <caption className="sr-only">Notification channels for each type</caption>
        <thead><tr><th scope="col">Type</th>{CHANNELS.map(ch => <th key={ch} scope="col">{CHANNEL_LABEL[ch]}</th>)}</tr></thead>
        <tbody>
          {CATEGORIES.map(c => {
            const info = cats.find(x => x.category === c);
            if (!info) return null;
            return (
              <tr key={c}>
                <th scope="row">{info.label}<span>{info.text}</span></th>
                {CHANNELS.map(ch => {
                  const locked = info.locked.includes(ch);
                  const na = ch === "sms" && (!info.smsAllowed || !phone);
                  return (
                    <td key={ch}>
                      <input type="checkbox" aria-label={`${info.label}: ${CHANNEL_LABEL[ch]}`} checked={prefs[c][ch]} disabled={locked || (na && !prefs[c][ch])}
                        onChange={e => set(c, ch, e.target.checked)} />
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      {!phone ? <p className="nt-sms-note">To get text messages, <a href="/buyer/verification">verify your phone number</a> first.</p> : null}
      <div><button type="submit" disabled={busy}>{busy ? "Saving…" : "Save settings"}</button></div>
    </form>
  );
}

function Elena({ onGoSettings }: { onGoSettings: () => void }) {
  const [reply, setReply] = useState<ElenaReply | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const ask = async (body: unknown) => {
    setBusy(true);
    const r = await api("/api/notifications/assistant", "POST", body);
    setBusy(false);
    if (!r?.ok) return setReply({ text: "Sorry, I couldn't answer just now. Please try again.", pose: "front", links: [] });
    const d = (await r.json()) as { reply: ElenaReply; suggestions?: Suggestion[]; note: string };
    setReply(d.reply); setNote(d.note); setSuggestions(d.suggestions ?? []);
  };
  const apply = async (s: Suggestion) => {
    const cur = await fetch("/api/notifications/preferences").then(r => r.json()).catch(() => null) as { preferences: Preferences } | null;
    if (!cur) return;
    const r = await api("/api/notifications/preferences", "PUT", { preferences: { [s.category]: { ...cur.preferences[s.category], [s.channel]: s.turnOn } } });
    if (r?.ok) { setSuggestions(list => list.filter(x => x !== s)); setReply({ text: "Done. You can change it back in Settings any time.", pose: "wave", links: [] }); }
  };

  return (
    <aside className="nt-elena" aria-label="Elena, your assistant">
      <header>
        <img src={`/assistant/elena-pose-${reply?.pose === "tablet" ? "tablet" : reply?.pose === "listening" ? "listening" : reply?.pose === "wave" ? "wave" : "front"}.jpg`} alt="" width={64} height={64} />
        <h2>Ask Elena</h2>
      </header>
      <div className="nt-elena-chips">
        <button type="button" className="button" disabled={busy} onClick={() => void ask({ action: "summary" })}>Catch me up</button>
        <button type="button" className="button" disabled={busy} onClick={() => void ask({ action: "suggest" })}>Suggest settings</button>
      </div>
      <form onSubmit={e => { e.preventDefault(); if (q.trim()) void ask({ action: "ask", question: q }); }}>
        <label htmlFor="nt-q">Ask about notifications</label>
        <input id="nt-q" value={q} maxLength={300} onChange={e => setQ(e.target.value)} placeholder="How do I turn off texts?" />
        <button type="submit" disabled={busy || !q.trim()}>Ask</button>
      </form>
      <div aria-live="polite">
        {reply ? (
          <>
            <p className="nt-elena-answer">{reply.text}</p>
            {suggestions.map(s => (
              <p key={`${s.category}-${s.channel}`}><button type="button" className="button" onClick={() => void apply(s)}>{s.turnOn ? "Turn on" : "Turn off"} {CHANNEL_LABEL[s.channel].toLowerCase()} for {s.category}</button></p>
            ))}
            {reply.links.map(l => l.href.startsWith("/notifications?tab=preferences")
              ? <p key={l.href}><button type="button" className="button" onClick={onGoSettings}>{l.label}</button></p>
              : <p key={l.href}><a href={l.href}>{l.label}</a></p>)}
          </>
        ) : null}
      </div>
      <p className="nt-elena-note">{note || "General help with notifications only. Not legal, financial or tax advice."}</p>
    </aside>
  );
}
