"use client";
import { useCallback, useEffect, useState } from "react";
import { loadError, postStaff } from "../staff-api";
import "../../styles/staff.css";

type Decision = "approve" | "reject" | "escalate";
interface Item {
  id: string; subjectType: "listing" | "message" | "profile"; subjectId: string; subjectLabel: string; subjectOwnerId: string | null; source: string;
  reason: string; detail: string | null; severity: "low" | "medium" | "high"; status: string; createdAt: string; decidedAt: string | null;
  decisionNote: string | null; history: { action: string; actorId: string | null; note: string | null; at: string }[];
}
interface Data {
  items: Item[]; counts: { open: number; escalated: number }; me: string; decisions: { open: Decision[]; escalated: Decision[] };
  canSuspend: { listing: boolean; account: boolean };
}
type Suspend = "none" | "listing" | "account";
interface Plan { suspend: Suspend; keepListings: boolean; confirm: boolean }

const VIEWS = [["open", "Waiting"], ["escalated", "Escalated"], ["decided", "Decided"]] as const;
const TYPES = [["", "Everything"], ["listing", "Listings"], ["message", "Messages"], ["profile", "Profiles"]] as const;
const DECISION_LABEL: Record<Decision, string> = { approve: "Approve", reject: "Reject", escalate: "Escalate" };
const HISTORY_LABEL: Record<string, string> = { raised: "Flagged", approve: "Approved", reject: "Rejected", escalate: "Escalated" };
const words = (s: string) => s.replace(/_/g, " ");
const when = (s: string) => new Date(s).toLocaleString("en-AU");

/**
 * One queue for flagged listings, messages and profiles. Approve means the content is fine, reject means it breaks the rules
 * (the content itself is then dealt with on the listing or user screens), escalate hands it to a senior reviewer.
 * Every decision needs a reason and goes into the history shown on the card.
 */
export default function StaffReviewQueue() {
  const [view, setView] = useState<(typeof VIEWS)[number][0]>("open");
  const [type, setType] = useState<(typeof TYPES)[number][0]>("");
  const [data, setData] = useState<Data | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [plans, setPlans] = useState<Record<string, Plan>>({});
  const [message, setMessage] = useState("");
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    setLoaded(false);
    const r = await fetch(`/api/staff/review-queue?view=${view}${type ? `&type=${type}` : ""}`).catch(() => null);
    if (!r || !r.ok) { setMessage(loadError(r?.status ?? 0)); return; }
    setData(await r.json()); setLoaded(true);
  }, [view, type]);
  useEffect(() => { void load(); }, [load]);

  const planOf = (id: string): Plan => plans[id] ?? { suspend: "none", keepListings: false, confirm: false };
  const setPlan = (id: string, p: Partial<Plan>) => setPlans(all => ({ ...all, [id]: { ...planOf(id), ...p } }));

  async function decide(id: string, decision: Decision) {
    setMessage("");
    const p = planOf(id);
    const extra = decision === "reject" && p.suspend !== "none"
      ? { suspend: p.suspend, confirm: p.confirm, ...(p.suspend === "account" ? { listings: p.keepListings ? "keep" : "suspend" } : {}) } : {};
    const res = await postStaff(`/api/staff/review-queue/${id}`, { decision, reason: reasons[id] ?? "", ...extra });
    setMessage(res.ok ? `${DECISION_LABEL[decision]}: recorded${res.data["suspended"] ? `, ${String(res.data["suspended"])} suspended` : ""}.` : String(res.data["error"] ?? "Failed."));
    if (res.ok) { setReasons(r => ({ ...r, [id]: "" })); setPlans(all => { const { [id]: _gone, ...rest } = all; return rest; }); await load(); }
  }

  return (
    <main>
      <h1>Moderation queue</h1>
      <p><a href="/staff">Back to staff</a></p>
      <p className="muted">
        Listings, messages and profiles that a filter or a report flagged. Approve when the content is fine, reject when it breaks the rules,
        or escalate when you need a senior reviewer. Say why every time. You cannot review your own content.
      </p>
      <div className="actions" role="tablist" aria-label="Queue">
        {VIEWS.map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={view === k} className={view === k ? "" : "secondary"} onClick={() => setView(k)}>
            {l}{data && k !== "decided" ? ` (${data.counts[k]})` : ""}
          </button>
        ))}
      </div>
      <div className="actions" role="group" aria-label="Content type">
        {TYPES.map(([k, l]) => (
          <button key={k || "all"} type="button" aria-pressed={type === k} className={type === k ? "" : "secondary"} onClick={() => setType(k)}>{l}</button>
        ))}
      </div>
      {message && <p role="alert">{message}</p>}
      {!loaded && !message && <p className="muted" role="status">Loading...</p>}
      {loaded && data && data.items.length === 0 && <p className="empty">Nothing here.</p>}
      <ul className="card-list">
        {data?.items.map(i => {
          const options = i.status === "open" ? data.decisions.open : i.status === "escalated" ? data.decisions.escalated : [];
          const own = i.subjectOwnerId !== null && i.subjectOwnerId === data.me;
          return (
            <li key={i.id} className="card mq-item">
              <h2 className="mq-title">{i.subjectLabel}</h2>
              <p className="mq-meta">
                <span className="badge">{i.subjectType}</span>
                <span className={`badge mq-sev-${i.severity}`}>{i.severity} severity</span>
                {i.status !== "open" && <span className="badge">{words(i.status)}</span>}
                <span className="muted">{words(i.source)} · {when(i.createdAt)}</span>
              </p>
              <p><strong>{i.reason}</strong></p>
              {i.detail && <blockquote className="mq-detail">{i.detail}</blockquote>}
              {i.subjectType === "listing" && <p><a href={`/listings/${i.subjectId}`}>Open the listing</a></p>}
              <ol className="mq-history" aria-label="History">
                {i.history.map((h, n) => (
                  <li key={n}><strong>{HISTORY_LABEL[h.action] ?? h.action}</strong> <span className="muted">{when(h.at)}</span>{h.note && <> · {h.note}</>}</li>
                ))}
              </ol>
              {options.length > 0 && !own && (
                <form className="stack" onSubmit={e => e.preventDefault()}>
                  <label>Reason (required, at least 10 characters)
                    <textarea className="staff-reason" value={reasons[i.id] ?? ""} onChange={e => setReasons({ ...reasons, [i.id]: e.target.value })} />
                  </label>
                  {options.includes("reject") && (data.canSuspend.account || (i.subjectType === "listing" && data.canSuspend.listing)) && (
                    <fieldset className="mq-suspend">
                      <legend>If you reject this</legend>
                      <label className="mq-choice"><input type="radio" name={`sus-${i.id}`} checked={planOf(i.id).suspend === "none"} onChange={() => setPlan(i.id, { suspend: "none", confirm: false })} /> Only record the rejection</label>
                      {i.subjectType === "listing" && data.canSuspend.listing && (
                        <label className="mq-choice"><input type="radio" name={`sus-${i.id}`} checked={planOf(i.id).suspend === "listing"} onChange={() => setPlan(i.id, { suspend: "listing", confirm: false })} /> Also suspend this listing</label>
                      )}
                      {i.subjectOwnerId && data.canSuspend.account && (
                        <label className="mq-choice"><input type="radio" name={`sus-${i.id}`} checked={planOf(i.id).suspend === "account"} onChange={() => setPlan(i.id, { suspend: "account", confirm: false })} /> Also suspend the account that wrote this</label>
                      )}
                      {planOf(i.id).suspend === "account" && (
                        <label className="mq-choice"><input type="checkbox" checked={planOf(i.id).keepListings} onChange={e => setPlan(i.id, { keepListings: e.target.checked })} /> Keep the account&apos;s live listings published</label>
                      )}
                      {planOf(i.id).suspend !== "none" && (
                        <label className="mq-choice mq-confirm"><input type="checkbox" checked={planOf(i.id).confirm} onChange={e => setPlan(i.id, { confirm: e.target.checked })} /> I confirm. The {planOf(i.id).suspend === "listing" ? "listing is taken offline" : "person is signed out and cannot use the site"} straight away, and this is logged with my reason.</label>
                      )}
                    </fieldset>
                  )}
                  <div className="actions">
                    {options.map(d => (
                      <button key={d} type="button" className={d === "approve" ? "" : "secondary"}
                        disabled={d === "reject" && planOf(i.id).suspend !== "none" && !planOf(i.id).confirm}
                        onClick={() => void decide(i.id, d)}>
                        {d === "reject" && planOf(i.id).suspend !== "none" ? `Reject and suspend ${planOf(i.id).suspend}` : DECISION_LABEL[d]}
                      </button>
                    ))}
                  </div>
                </form>
              )}
              {own && options.length > 0 && <p className="muted">This is your own content, so someone else must review it.</p>}
              {i.status === "escalated" && options.length === 0 && <p className="muted">Waiting for a senior reviewer.</p>}
            </li>
          );
        })}
      </ul>
    </main>
  );
}
