import { createHash } from "node:crypto";
import type { AiEnginePort } from "./ai-engine";
import type { Jurisdiction } from "./jurisdiction";

/**
 * Shared pieces of the AI pipeline (spec 5.1): versioned prompts, the input hash that makes a draft reproducible,
 * the AI-assistance footer, the wording-filter port and quiet hours. Every AI feature (reply drafts, offer suggestions,
 * price guidance, safety review) builds on these, so the rules stay in one place.
 */

/** Bump a version whenever a prompt's wording changes, so every stored draft says which prompt wrote it. */
export const PROMPT_VERSIONS = {
  enquiryReply: "enquiry-reply@1",
  enquiryIntent: "enquiry-intent@1",
  offerResponse: "offer-response@1",
  priceExplainer: "price-explainer@1",
  safetyReview: "safety-review@1"
} as const;
export type PromptVersion = (typeof PROMPT_VERSIONS)[keyof typeof PROMPT_VERSIONS];

/** Added to every message an AI drafted, before it reaches a buyer (spec 2.4 and 5.1). */
export const AI_FOOTER = "This reply was drafted with AI assistance and checked by the seller before sending.";

export function withFooter(text: string): string {
  const t = text.trim();
  return t.endsWith(AI_FOOTER) ? t : `${t}\n\n${AI_FOOTER}`;
}

export function hasFooter(text: string): boolean {
  return text.trim().endsWith(AI_FOOTER);
}

/** Text without the footer, for editing on screen. */
export function stripFooter(text: string): string {
  const t = text.trim();
  return t.endsWith(AI_FOOTER) ? t.slice(0, -AI_FOOTER.length).trim() : t;
}

/** SHA-256 over the prompt version and every input, so any stored draft can be reproduced and checked. */
export function inputHash(promptVersion: string, ...parts: readonly string[]): string {
  const h = createHash("sha256");
  h.update(promptVersion);
  for (const p of parts) { h.update("\u0000"); h.update(p); }
  return h.digest("hex");
}

/** What a stored AI draft records about where it came from (ai_draft engine_id, model_version, prompt_version, input_hash). */
export interface DraftProvenance { engineId: string; modelVersion: string; promptVersion: string; inputHash: string }

export function provenance(engine: AiEnginePort, promptVersion: string, hash: string): DraftProvenance {
  const info = engine.info();
  return { engineId: info.id, modelVersion: info.version, promptVersion, inputHash: hash };
}

// ---- Wording filter port (anti-discrimination, spec 6.4) ----

export interface WordingFlag { category: string; match: string; suggestion?: string }
export interface WordingResult { blocked: boolean; flags: readonly WordingFlag[]; installed: boolean }
/** The anti-discrimination wording filter. Built separately (src/domain/discrimination-filter.ts); the pipeline only calls it. */
export type WordingFilter = (text: string) => WordingResult;

/** Used until the real filter is wired in. Fails closed: AI text cannot pass a filter that is not there. */
export const wordingFilterNotInstalled: WordingFilter = () => ({ blocked: true, flags: [], installed: false });

// ---- Quiet hours (spec 5.3: default 8pm to 8am in the property's state) ----

export interface QuietHours { from: string; to: string }
export const DEFAULT_QUIET_HOURS: QuietHours = { from: "20:00", to: "08:00" };

const STATE_TZ: Record<Jurisdiction, string> = {
  NSW: "Australia/Sydney", VIC: "Australia/Melbourne", QLD: "Australia/Brisbane", WA: "Australia/Perth",
  SA: "Australia/Adelaide", TAS: "Australia/Hobart", ACT: "Australia/Sydney", NT: "Australia/Darwin"
};

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutesOf = (hhmm: string): number => {
  const m = HHMM.exec(hhmm);
  if (!m) throw new Error(`Bad time ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
};

/** Minutes since local midnight in the property's state. */
export function localMinutes(nowIso: string, state: Jurisdiction): number {
  const parts = new Intl.DateTimeFormat("en-AU", { timeZone: STATE_TZ[state], hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(nowIso));
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? "0");
  return get("hour") * 60 + get("minute");
}

export function inQuietHours(nowIso: string, state: Jurisdiction, q: QuietHours = DEFAULT_QUIET_HOURS): boolean {
  const now = localMinutes(nowIso, state), from = minutesOf(q.from), to = minutesOf(q.to);
  if (from === to) return false;
  return from < to ? now >= from && now < to : now >= from || now < to;
}

/** The earliest time at or after now that is outside quiet hours (to the minute). Buyer-facing AI sends wait until then. */
export function nextSendTime(nowIso: string, state: Jurisdiction, q: QuietHours = DEFAULT_QUIET_HOURS): string {
  if (!inQuietHours(nowIso, state, q)) return nowIso;
  const wait = (minutesOf(q.to) - localMinutes(nowIso, state) + 24 * 60) % (24 * 60);
  const t = new Date(nowIso);
  t.setUTCSeconds(0, 0);
  return new Date(t.getTime() + wait * 60_000).toISOString();
}

// ---- Strict JSON from a model ----

/** Pulls the first {...} object out of model text and parses it. Undefined for anything else; callers validate every field. */
export function parseModelJson(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const v: unknown = JSON.parse(text.slice(start, end + 1));
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
