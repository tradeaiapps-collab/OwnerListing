import {
  DEFAULT_QUESTION_ORDER, DEFAULT_WEIGHTS, SCORE_COMPONENTS, SLOT_KEYS, type LeadSlots, type QualifierConfig, type ScoreComponent, type ScoreWeights, type SlotKey
} from "./lead-qualifier";

/**
 * The learning loop. Past leads with a known result (converted, lost, unresponsive) show which answers actually predict a conversion
 * and which questions make people give up. From that a new config is proposed: score weights and question order. It is cautious by design:
 * nothing changes under MIN_SAMPLE results, each weight can move at most 50% from its default, and a person (staff) activates every version.
 * It reads only the answers Elena asks for, never a name, contact detail or any protected attribute.
 */

export type LeadResult = "converted" | "lost" | "unresponsive";
export interface LabelledLead {
  slots: LeadSlots;
  result: LeadResult;
  /** How many times each slot was asked of this lead. */
  asked: Partial<Record<SlotKey, number>>;
  /** The slot Elena last asked when the lead stopped replying, if it did. */
  abandonedAfter?: SlotKey | undefined;
  /** True for chats that died before routing: they feed the question drop-off figures only, never the weights (they would bias toward 'more answers = better'). */
  abandoned?: boolean | undefined;
}

export const MIN_SAMPLE = 30;
export const MIN_GROUP = 8;
/** How much evidence it takes before learned values count fully (a shrinkage constant). */
export const SHRINK = 50;
export const MAX_SHIFT = 0.5;

/** True when the lead gave a strong answer for the component: this is what "predicts" is measured on. */
export function strongSignal(c: ScoreComponent, s: LeadSlots): boolean {
  switch (c) {
    case "timeline": return s.timeline === "now" || s.timeline === "1m" || s.timeline === "3m" || s.urgent === true;
    case "budget": return s.budgetMax !== undefined;
    case "location": return s.postcode !== undefined && s.suburb !== undefined;
    case "propertyType": return s.propertyType !== undefined;
    case "motivation": return s.motivation !== undefined && s.motivation !== "other";
    case "finance": return s.financeReady === "yes";
    case "contact": return s.phone !== undefined && s.email !== undefined;
  }
}

const rate = (xs: readonly LabelledLead[]) => (xs.length === 0 ? 0 : xs.filter(x => x.result === "converted").length / xs.length);

export interface Lift { component: ScoreComponent; strongN: number; weakN: number; strongRate: number; weakRate: number; lift: number }

/** Conversion rate with the signal over the rate without it, softened (add-one on both sides) so tiny groups cannot swing it. */
export function liftOf(component: ScoreComponent, data: readonly LabelledLead[]): Lift {
  const strong = data.filter(d => strongSignal(component, d.slots)), weak = data.filter(d => !strongSignal(component, d.slots));
  const sr = (strong.filter(x => x.result === "converted").length + 1) / (strong.length + 2);
  const wr = (weak.filter(x => x.result === "converted").length + 1) / (weak.length + 2);
  return { component, strongN: strong.length, weakN: weak.length, strongRate: rate(strong), weakRate: rate(weak), lift: sr / wr };
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Rounds to integers that add to exactly 100 (largest remainder). */
export function normaliseTo100(raw: Record<ScoreComponent, number>): ScoreWeights {
  const sum = SCORE_COMPONENTS.reduce((a, c) => a + raw[c], 0) || 1;
  const scaled = SCORE_COMPONENTS.map(c => ({ c, v: (raw[c] * 100) / sum }));
  const out = {} as ScoreWeights;
  let used = 0;
  for (const x of scaled) { out[x.c] = Math.floor(x.v); used += out[x.c]; }
  for (const x of [...scaled].sort((a, b) => (b.v - Math.floor(b.v)) - (a.v - Math.floor(a.v)) || (a.c < b.c ? -1 : 1))) {
    if (used >= 100) break;
    out[x.c] += 1; used++;
  }
  return out;
}

export interface LearnedConfig { config: QualifierConfig; lifts: Lift[]; dropoff: { slot: SlotKey; asked: number; abandoned: number; rate: number }[]; changed: boolean; note: string }

export function learnConfig(all: readonly LabelledLead[], current: QualifierConfig): LearnedConfig {
  const data = all.filter(d => !d.abandoned);
  const lifts = SCORE_COMPONENTS.map(c => liftOf(c, data));
  const dropoff = SLOT_KEYS.map(slot => {
    const asked = all.filter(d => (d.asked[slot] ?? 0) > 0).length;
    const abandoned = all.filter(d => d.abandonedAfter === slot).length;
    return { slot, asked, abandoned, rate: asked === 0 ? 0 : abandoned / asked };
  });
  if (data.length < MIN_SAMPLE) {
    return { config: current, lifts, dropoff, changed: false, note: `Only ${data.length} results; ${MIN_SAMPLE} are needed before anything changes.` };
  }
  const trust = data.length / (data.length + SHRINK);
  const raw = {} as Record<ScoreComponent, number>;
  for (const l of lifts) {
    const enough = l.strongN >= MIN_GROUP && l.weakN >= MIN_GROUP;
    const factor = enough ? 1 + (clamp(l.lift, 1 - MAX_SHIFT, 1 + MAX_SHIFT) - 1) * trust : 1;
    raw[l.component] = DEFAULT_WEIGHTS[l.component] * clamp(factor, 1 - MAX_SHIFT, 1 + MAX_SHIFT);
  }
  const weights = normaliseTo100(raw);

  // Order: goal and location stay first (routing needs them). The rest go by how predictive the answer is, discounted by how often asking it ends the chat.
  const liftFor = (slot: SlotKey): number => {
    const comp: Partial<Record<SlotKey, ScoreComponent>> = { timeline: "timeline", budget: "budget", propertyType: "propertyType", motivation: "motivation", finance: "finance", contact: "contact" };
    const c = comp[slot];
    return c ? (lifts.find(l => l.component === c)?.lift ?? 1) : 1;
  };
  const drop = (slot: SlotKey) => dropoff.find(d => d.slot === slot)?.rate ?? 0;
  const base = (slot: SlotKey) => DEFAULT_QUESTION_ORDER.length - DEFAULT_QUESTION_ORDER.indexOf(slot);
  const rest = DEFAULT_QUESTION_ORDER.filter(k => k !== "goal" && k !== "location")
    .map(k => ({ k, p: base(k) * clamp(liftFor(k), 0.7, 1.4) / (1 + 2 * drop(k)) }))
    .sort((a, b) => b.p - a.p || (a.k < b.k ? -1 : 1)).map(x => x.k);
  const questionOrder: SlotKey[] = ["goal", "location", ...rest];

  const changed = SCORE_COMPONENTS.some(c => weights[c] !== current.weights[c]) || questionOrder.some((k, i) => k !== current.questionOrder[i]);
  return {
    config: { version: current.version + 1, weights, questionOrder, sampleSize: data.length }, lifts, dropoff, changed,
    note: `Learned from ${data.length} results (${Math.round(rate(data) * 100)}% converted).`
  };
}
