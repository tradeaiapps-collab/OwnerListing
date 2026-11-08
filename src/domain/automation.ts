/**
 * Automation: a workflow is "when this happens, and these conditions hold, run these steps".
 * Steps are send (email, SMS, in-app), wait, branch (a condition choosing the next step) and stop.
 * Pure rules: validation, the condition engine, template merge fields and the run state machine. No I/O here.
 *
 * Safety rules baked in:
 * - Branches only jump FORWARD, so a workflow can never loop.
 * - Messages to a contact (the buyer behind an enquiry or offer) go out as marketing: opt-in, unsubscribe link, no SMS unless the
 *   notification rules allow it. The recipient is resolved on the server from the event, never typed into a workflow.
 * - Merge fields are a fixed list of listing facts and a first name. No amounts beyond the offer price the owner already sees.
 */

export const TRIGGERS = {
  new_lead: { label: "New lead", blurb: "A buyer sends an enquiry on one of your listings.", contact: true, fields: ["listing_title", "listing_suburb_text", "contact_first_name", "enquiries_on_listing"] },
  property_listed: { label: "Property listed", blurb: "One of your listings is published.", contact: false, fields: ["listing_title", "listing_suburb_text", "transaction_type", "property_type"] },
  offer_received: { label: "Offer received", blurb: "A buyer submits a formal offer.", contact: true, fields: ["listing_title", "contact_first_name", "offer_price", "offers_on_listing", "settlement_days"] },
  inspection_complete: { label: "Inspection complete", blurb: "An inspector marks an inspection as completed.", contact: false, fields: ["listing_title", "inspection_type", "findings_count"] }
} as const satisfies Record<string, { label: string; blurb: string; contact: boolean; fields: readonly string[] }>;
export type TriggerKey = keyof typeof TRIGGERS;
export const isTrigger = (v: unknown): v is TriggerKey => typeof v === "string" && Object.prototype.hasOwnProperty.call(TRIGGERS, v);

/** Every field a condition or merge field can use, with its type. Strings compare case-insensitively. */
export const FIELDS = {
  listing_title: { label: "Listing title", type: "text" },
  listing_suburb_text: { label: "Listing address", type: "text" },
  transaction_type: { label: "Sale or rent", type: "text" },
  property_type: { label: "Property type", type: "text" },
  contact_first_name: { label: "Contact first name", type: "text" },
  enquiries_on_listing: { label: "Enquiries on this listing", type: "number" },
  offers_on_listing: { label: "Offers on this listing", type: "number" },
  offer_price: { label: "Offer price (AUD)", type: "number" },
  settlement_days: { label: "Settlement days", type: "number" },
  inspection_type: { label: "Inspection type", type: "text" },
  findings_count: { label: "Findings recorded", type: "number" }
} as const satisfies Record<string, { label: string; type: "text" | "number" }>;
export type FieldKey = keyof typeof FIELDS;
const FIELD_KEYS = Object.keys(FIELDS) as FieldKey[];
export const isField = (v: unknown): v is FieldKey => typeof v === "string" && Object.prototype.hasOwnProperty.call(FIELDS, v);

export const OPS = { eq: "is", neq: "is not", gt: "more than", gte: "at least", lt: "less than", lte: "at most", contains: "contains", not_contains: "does not contain" } as const;
export type Op = keyof typeof OPS;
const NUMERIC_OPS: readonly Op[] = ["gt", "gte", "lt", "lte"];
const TEXT_OPS: readonly Op[] = ["eq", "neq", "contains", "not_contains"];

export interface Condition { field: FieldKey; op: Op; value: string | number }
/** "all" means every condition must hold (AND), "any" means at least one (OR). An empty group always holds. */
export interface ConditionGroup { match: "all" | "any"; conditions: Condition[] }

export type Channel = "email" | "sms" | "in_app";
export type StepId = string;
export interface SendStep { id: StepId; kind: "send"; channel: Channel; to: "contact" | "owner"; subject: string; body: string }
export interface WaitStep { id: StepId; kind: "wait"; minutes: number }
export interface BranchStep { id: StepId; kind: "branch"; when: ConditionGroup; then: StepId | "end"; otherwise: StepId | "end" }
export interface StopStep { id: StepId; kind: "stop" }
export type Step = SendStep | WaitStep | BranchStep | StopStep;

export interface WorkflowDefinition { trigger: TriggerKey; when: ConditionGroup; steps: Step[] }

export const LIMITS = { steps: 20, waitMinutesMax: 30 * 24 * 60, totalWaitMinutesMax: 60 * 24 * 60, conditions: 10, subject: 120, body: 1000, name: 80, perOwner: 25 } as const;
const MERGE = /\{\{\s*([a-z_]+)\s*\}\}/g;

export type Failure = { ok: false; message: string };
export type Valid<T> = { ok: true; value: T } | Failure;
const bad = (message: string): Failure => ({ ok: false, message });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// ---- Condition engine ------------------------------------------------------------------------------------------------------------

export type Facts = Partial<Record<FieldKey, string | number>>;

export function evalCondition(c: Condition, facts: Facts): boolean {
  const have = facts[c.field];
  if (have === undefined) return false; // a missing fact never matches, not even "is not"
  if (FIELDS[c.field].type === "number") {
    const a = Number(have), b = Number(c.value);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    switch (c.op) { case "eq": return a === b; case "neq": return a !== b; case "gt": return a > b; case "gte": return a >= b; case "lt": return a < b; case "lte": return a <= b; default: return false; }
  }
  const a = String(have).toLowerCase(), b = String(c.value).toLowerCase();
  switch (c.op) { case "eq": return a === b; case "neq": return a !== b; case "contains": return a.includes(b); case "not_contains": return !a.includes(b); default: return false; }
}

export function evalGroup(g: ConditionGroup, facts: Facts): boolean {
  if (g.conditions.length === 0) return true;
  return g.match === "all" ? g.conditions.every(c => evalCondition(c, facts)) : g.conditions.some(c => evalCondition(c, facts));
}

/** Replaces {{field}} with the fact, or an empty string. Unknown names are left out, so a typo can never leak anything. */
export function mergeText(text: string, facts: Facts): string {
  return text.replace(MERGE, (_m, k: string) => (isField(k) && facts[k] !== undefined ? (k === "offer_price" ? aud(Number(facts[k])) : String(facts[k])) : ""))
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, " ").trim();
}
const aud = (dollars: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(dollars);

// ---- Validation ------------------------------------------------------------------------------------------------------------------

function parseGroup(raw: unknown, where: string): Valid<ConditionGroup> {
  if (raw === undefined || raw === null) return { ok: true, value: { match: "all", conditions: [] } };
  if (!isObj(raw) || (raw["match"] !== "all" && raw["match"] !== "any") || !Array.isArray(raw["conditions"])) return bad(`${where}: conditions need match "all" or "any" and a list.`);
  if (raw["conditions"].length > LIMITS.conditions) return bad(`${where}: at most ${LIMITS.conditions} conditions.`);
  const conditions: Condition[] = [];
  for (const c of raw["conditions"]) {
    if (!isObj(c) || !isField(c["field"]) || typeof c["op"] !== "string" || !Object.prototype.hasOwnProperty.call(OPS, c["op"])) return bad(`${where}: each condition needs a known field and operator.`);
    const field = c["field"], op = c["op"] as Op, numeric = FIELDS[field].type === "number";
    if (!(numeric ? [...NUMERIC_OPS, "eq", "neq"] : TEXT_OPS).includes(op)) return bad(`${where}: "${OPS[op]}" cannot be used with ${FIELDS[field].label.toLowerCase()}.`);
    const v = c["value"];
    if (numeric) { if ((typeof v !== "number" && typeof v !== "string") || v === "" || !Number.isFinite(Number(v))) return bad(`${where}: ${FIELDS[field].label} needs a number.`); conditions.push({ field, op, value: Number(v) }); }
    else { if (typeof v !== "string" || v.trim() === "" || v.length > 120) return bad(`${where}: ${FIELDS[field].label} needs a short text value.`); conditions.push({ field, op, value: v.trim() }); }
  }
  return { ok: true, value: { match: raw["match"], conditions } };
}

const text = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim().length <= max ? v.trim() : undefined);

/** Checks a definition from the browser or API and returns a clean copy. Unknown keys are dropped. */
export function parseDefinition(raw: unknown): Valid<WorkflowDefinition> {
  if (!isObj(raw)) return bad("Send the workflow as an object.");
  if (!isTrigger(raw["trigger"])) return bad("Pick a trigger.");
  const trigger = raw["trigger"];
  const when = parseGroup(raw["when"], "Trigger filter");
  if (!when.ok) return when;
  if (!Array.isArray(raw["steps"]) || raw["steps"].length === 0) return bad("Add at least one step.");
  if (raw["steps"].length > LIMITS.steps) return bad(`At most ${LIMITS.steps} steps.`);
  const allowed = new Set<string>(TRIGGERS[trigger].fields);
  const ids: string[] = [];
  for (const s of raw["steps"]) {
    if (!isObj(s) || typeof s["id"] !== "string" || !/^[a-z0-9_-]{1,24}$/.test(s["id"])) return bad("Each step needs a short id (letters, digits, - or _).");
    if (ids.includes(s["id"])) return bad(`Step id "${s["id"]}" is used twice.`);
    ids.push(s["id"]);
  }
  const steps: Step[] = [];
  let totalWait = 0;
  for (let i = 0; i < raw["steps"].length; i++) {
    const s = raw["steps"][i] as Record<string, unknown>, id = s["id"] as string, at = `Step ${i + 1}`;
    if (s["kind"] === "wait") {
      const m = Number(s["minutes"]);
      if (!Number.isInteger(m) || m < 1 || m > LIMITS.waitMinutesMax) return bad(`${at}: wait between 1 minute and 30 days.`);
      totalWait += m; steps.push({ id, kind: "wait", minutes: m });
    } else if (s["kind"] === "send") {
      const channel = s["channel"], to = s["to"];
      if (channel !== "email" && channel !== "sms" && channel !== "in_app") return bad(`${at}: choose email, SMS or in-app.`);
      if (to !== "contact" && to !== "owner") return bad(`${at}: choose who receives it.`);
      if (to === "contact" && !TRIGGERS[trigger].contact) return bad(`${at}: "${TRIGGERS[trigger].label}" has no contact to message. Send it to yourself instead.`);
      const subject = text(s["subject"] ?? "", LIMITS.subject), body = text(s["body"], LIMITS.body);
      if (subject === undefined) return bad(`${at}: subject is too long.`);
      if (!body) return bad(`${at}: write the message.`);
      for (const m of `${subject} ${body}`.matchAll(MERGE)) if (!isField(m[1]) || !allowed.has(m[1])) return bad(`${at}: {{${m[1]}}} is not available for this trigger.`);
      steps.push({ id, kind: "send", channel, to, subject, body });
    } else if (s["kind"] === "branch") {
      const g = parseGroup(s["when"], at);
      if (!g.ok) return g;
      if (g.value.conditions.length === 0) return bad(`${at}: a branch needs at least one condition.`);
      const target = (v: unknown): StepId | "end" | undefined => (v === "end" ? "end" : typeof v === "string" && ids.indexOf(v) > i ? v : undefined);
      const t = target(s["then"]), o = target(s["otherwise"]);
      if (t === undefined || o === undefined) return bad(`${at}: a branch can only jump forward to a later step, or end.`);
      steps.push({ id, kind: "branch", when: g.value, then: t, otherwise: o });
    } else if (s["kind"] === "stop") steps.push({ id, kind: "stop" });
    else return bad(`${at}: unknown step type.`);
  }
  if (totalWait > LIMITS.totalWaitMinutesMax) return bad("The waits add up to more than 60 days.");
  return { ok: true, value: { trigger, when: when.value, steps } };
}

export function parseName(v: unknown): Valid<string> {
  const n = typeof v === "string" ? v.trim() : "";
  return n.length >= 1 && n.length <= LIMITS.name ? { ok: true, value: n } : bad(`Name the workflow (up to ${LIMITS.name} characters).`);
}

// ---- State machine ---------------------------------------------------------------------------------------------------------------

export type RunStatus = "running" | "waiting" | "completed" | "stopped" | "failed";
export interface RunState { status: RunStatus; stepIndex: number; wakeAt: string | null }
export type LogKind = "started" | "filtered_out" | "sent" | "waiting" | "branched" | "completed" | "stopped" | "failed";
export interface LogEntry { kind: LogKind; stepId: string | null; detail: string }
export interface SendAction { stepId: string; channel: Channel; to: "contact" | "owner"; subject: string; body: string }
export interface Advance { state: RunState; actions: SendAction[]; logs: LogEntry[] }

const MAX_TRANSITIONS = 60;

/** The run that starts when the trigger fires, or undefined (with a reason) when the trigger filter does not match. */
export function startRun(def: WorkflowDefinition, facts: Facts, now: string): { state: RunState; logs: LogEntry[] } | { skipped: string } {
  if (!evalGroup(def.when, facts)) return { skipped: "The trigger filter did not match." };
  return { state: { status: "running", stepIndex: 0, wakeAt: now }, logs: [{ kind: "started", stepId: null, detail: TRIGGERS[def.trigger].label }] };
}

/**
 * Runs a run forward from its current step until it must wait, stops or finishes. Sends are returned as actions for the caller to
 * perform; the new state is saved BEFORE they are sent, so a crash can lose a message but never send it twice.
 * A run that is waiting for a later time is returned unchanged.
 */
export function advance(def: WorkflowDefinition, state: RunState, facts: Facts, now: string): Advance {
  const actions: SendAction[] = [], logs: LogEntry[] = [];
  if (state.status === "completed" || state.status === "stopped" || state.status === "failed") return { state, actions, logs };
  if (state.wakeAt !== null && Date.parse(state.wakeAt) > Date.parse(now)) return { state, actions, logs };
  let i = state.stepIndex;
  for (let n = 0; n < MAX_TRANSITIONS; n++) {
    const s = def.steps[i];
    if (!s) { logs.push({ kind: "completed", stepId: null, detail: "All steps done." }); return { state: { status: "completed", stepIndex: i, wakeAt: null }, actions, logs }; }
    if (s.kind === "wait") {
      const wakeAt = new Date(Date.parse(now) + s.minutes * 60_000).toISOString();
      logs.push({ kind: "waiting", stepId: s.id, detail: `Waiting ${describeMinutes(s.minutes)}.` });
      return { state: { status: "waiting", stepIndex: i + 1, wakeAt }, actions, logs };
    }
    if (s.kind === "send") {
      actions.push({ stepId: s.id, channel: s.channel, to: s.to, subject: mergeText(s.subject, facts), body: mergeText(s.body, facts) });
      i += 1; continue;
    }
    if (s.kind === "branch") {
      const yes = evalGroup(s.when, facts), target = yes ? s.then : s.otherwise;
      logs.push({ kind: "branched", stepId: s.id, detail: `${yes ? "Yes" : "No"}: ${target === "end" ? "finish" : "go to " + target}.` });
      if (target === "end") { logs.push({ kind: "completed", stepId: null, detail: "Finished at a branch." }); return { state: { status: "completed", stepIndex: def.steps.length, wakeAt: null }, actions, logs }; }
      const to = def.steps.findIndex(x => x.id === target);
      if (to <= i) return { state: { status: "failed", stepIndex: i, wakeAt: null }, actions, logs: [...logs, { kind: "failed", stepId: s.id, detail: "A branch pointed backwards." }] };
      i = to; continue;
    }
    logs.push({ kind: "stopped", stepId: s.id, detail: "Stop step reached." });
    return { state: { status: "stopped", stepIndex: i + 1, wakeAt: null }, actions, logs };
  }
  return { state: { status: "failed", stepIndex: i, wakeAt: null }, actions, logs: [...logs, { kind: "failed", stepId: null, detail: "Too many steps in one pass." }] };
}

export function describeMinutes(m: number): string {
  if (m % 1440 === 0) return `${m / 1440} day${m === 1440 ? "" : "s"}`;
  if (m % 60 === 0) return `${m / 60} hour${m === 60 ? "" : "s"}`;
  return `${m} minute${m === 1 ? "" : "s"}`;
}

/** Dry run for the builder's "Test": walks the whole workflow on sample facts with waits skipped. Nothing is sent. */
export function simulate(def: WorkflowDefinition, facts: Facts, now = new Date(0).toISOString()): { matched: boolean; steps: { stepId: string | null; text: string }[] } {
  const start = startRun(def, facts, now);
  if ("skipped" in start) return { matched: false, steps: [{ stepId: null, text: start.skipped }] };
  const out: { stepId: string | null; text: string }[] = [];
  let state = start.state, t = Date.parse(now);
  for (let n = 0; n < LIMITS.steps + 2 && (state.status === "running" || state.status === "waiting"); n++) {
    if (state.wakeAt !== null) t = Math.max(t, Date.parse(state.wakeAt));
    const r = advance(def, state, facts, new Date(t).toISOString());
    for (const a of r.actions) out.push({ stepId: a.stepId, text: `${a.channel === "in_app" ? "In-app" : a.channel.toUpperCase()} to ${a.to === "owner" ? "you" : "the contact"}: ${a.subject ? a.subject + " — " : ""}${a.body}` });
    for (const l of r.logs) if (l.kind === "waiting" || l.kind === "branched" || l.kind === "stopped") out.push({ stepId: l.stepId, text: l.detail });
    state = r.state;
  }
  return { matched: true, steps: out };
}

/** Starter campaigns the designer offers. Plain definitions: the agent can edit every word. */
export const CAMPAIGN_TEMPLATES: { key: string; name: string; blurb: string; definition: WorkflowDefinition }[] = [
  {
    key: "lead_nurture", name: "New lead nurture", blurb: "Welcome a new enquirer, then follow up after 2 days and a week.",
    definition: {
      trigger: "new_lead", when: { match: "all", conditions: [] },
      steps: [
        { id: "welcome", kind: "send", channel: "email", to: "contact", subject: "Thanks for your interest in {{listing_title}}", body: "Hi {{contact_first_name}}, thanks for your enquiry about {{listing_title}}. Reply in the app with any questions and I will get back to you." },
        { id: "alert", kind: "send", channel: "in_app", to: "owner", subject: "New lead", body: "{{contact_first_name}} enquired about {{listing_title}}." },
        { id: "w1", kind: "wait", minutes: 2 * 1440 },
        { id: "followup", kind: "send", channel: "email", to: "contact", subject: "Any questions about {{listing_title}}?", body: "Hi {{contact_first_name}}, just checking in. Happy to answer questions or arrange an inspection." },
        { id: "w2", kind: "wait", minutes: 5 * 1440 },
        { id: "last", kind: "send", channel: "email", to: "contact", subject: "Still looking?", body: "Hi {{contact_first_name}}, {{listing_title}} is still available. Let me know if you would like to see it." }
      ]
    }
  },
  {
    key: "big_offer", name: "Offer follow-up", blurb: "Alert you at once on larger offers; thank every buyer and check in after a day.",
    definition: {
      trigger: "offer_received", when: { match: "all", conditions: [] },
      steps: [
        { id: "big", kind: "branch", when: { match: "all", conditions: [{ field: "offer_price", op: "gte", value: 1000000 }] }, then: "alert", otherwise: "thanks" },
        { id: "alert", kind: "send", channel: "in_app", to: "owner", subject: "Large offer", body: "An offer of {{offer_price}} came in on {{listing_title}}." },
        { id: "thanks", kind: "send", channel: "email", to: "contact", subject: "We received your offer", body: "Hi {{contact_first_name}}, thanks for your offer on {{listing_title}}. The owner will review it and respond." },
        { id: "w1", kind: "wait", minutes: 1440 },
        { id: "check", kind: "send", channel: "email", to: "contact", subject: "Your offer on {{listing_title}}", body: "Hi {{contact_first_name}}, your offer is still being considered. We will be in touch soon." }
      ]
    }
  },
  {
    key: "listing_launch", name: "Listing launch checklist", blurb: "Remind yourself to review enquiries one week after going live.",
    definition: {
      trigger: "property_listed", when: { match: "all", conditions: [] },
      steps: [
        { id: "live", kind: "send", channel: "in_app", to: "owner", subject: "Listing live", body: "{{listing_title}} is live. Share it and keep your photos fresh." },
        { id: "w1", kind: "wait", minutes: 7 * 1440 },
        { id: "review", kind: "send", channel: "in_app", to: "owner", subject: "One week on", body: "{{listing_title}} has been live for a week. Review enquiries and consider a price check." }
      ]
    }
  },
  {
    key: "inspection_followup", name: "Inspection follow-up", blurb: "When an inspection is done, prompt yourself to review findings, and again if there were many.",
    definition: {
      trigger: "inspection_complete", when: { match: "all", conditions: [] },
      steps: [
        { id: "done", kind: "send", channel: "in_app", to: "owner", subject: "Inspection complete", body: "The {{inspection_type}} inspection for {{listing_title}} is complete." },
        { id: "many", kind: "branch", when: { match: "all", conditions: [{ field: "findings_count", op: "gte", value: 5 }] }, then: "w1", otherwise: "end" },
        { id: "w1", kind: "wait", minutes: 2 * 1440 },
        { id: "chase", kind: "send", channel: "in_app", to: "owner", subject: "Review inspection findings", body: "{{findings_count}} findings on {{listing_title}} need attention." }
      ]
    }
  }
];
export { FIELD_KEYS };
