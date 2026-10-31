import { DEFAULT_BRAND_NAME } from "../../src/config/brand";

/**
 * Presenter core: the pure, testable part of the walking presenter (no DOM).
 * The presenter walks in place on a loop. Scripted lines are pre-rendered clips with real audio and lip-sync;
 * any other text is read aloud by the browser voice while she keeps walking (no lip-sync, mouth stays closed).
 * Anything on the page can make her speak by dispatching PRESENTER_SPEAK_EVENT.
 */

/** Dispatch on window with detail `{ text?: string; script?: ScriptId }`. A known script plays its clip; other text uses text-to-speech. */
export const PRESENTER_SPEAK_EVENT = "ol:presenter-speak";
/** Dispatch on window to stop whatever she is saying. */
export const PRESENTER_STOP_EVENT = "ol:presenter-stop";

/** Fired by the stage whenever her speaking state changes; detail is PresenterState. The controls listen to it. */
export const PRESENTER_STATE_EVENT = "ol:presenter-state";
/** Dispatched by the controls; detail is { action: "pause" | "mute" }. */
export const PRESENTER_CONTROL_EVENT = "ol:presenter-control";
export type PresenterState = { talking: "clip" | "tts" | null; paused: boolean; muted: boolean; blocked: boolean };

export type ScriptId = "intro" | "services" | "help";
/** `text` may contain {brand}. A line that says the brand aloud has its name baked into the clip, so the clip is only used while the site brand is unchanged. */
export type PresenterScript = { id: ScriptId; text: string };
export type SpeakRequest = { text?: string; script?: ScriptId };

/** Lines that exist as lip-synced clips (`public/assistant/elena-presenter-<id>*.{webm,mp4}`). The text must match the audio in the clip. */
export const SCRIPTS: readonly PresenterScript[] = [
  { id: "intro", text: "Hello, I'm Elena. Welcome to {brand}, where you can sell your home directly, without agent commissions." },
  { id: "services", text: "I can help you list your property, chat with interested buyers, and book viewings, all in one place." },
  { id: "help", text: "Not sure where to start? Just ask me a question, and I'll guide you through your dashboard." },
];

const withBrand = (t: string, brand: string) => t.replace(/\{brand\}/g, brand);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** The scripted line a request refers to, by id or by (punctuation- and case-insensitive) exact text. */
export function findScript(req: SpeakRequest, brand: string = DEFAULT_BRAND_NAME): PresenterScript | null {
  if (req.script) return SCRIPTS.find((s) => s.id === req.script) ?? null;
  if (!req.text) return null;
  const t = norm(req.text);
  return SCRIPTS.find((s) => norm(withBrand(s.text, brand)) === t) ?? null;
}

export type SpeakPlan =
  | { kind: "clip"; script: PresenterScript }
  | { kind: "tts"; text: string }
  | { kind: "none" };

/** Clip when a lip-synced one exists and clips are allowed; otherwise browser voice; otherwise nothing. */
export function planSpeech(req: SpeakRequest, opts: { clips: boolean; tts: boolean; muted: boolean; brand?: string }): SpeakPlan {
  const brand = opts.brand ?? DEFAULT_BRAND_NAME;
  const found = findScript(req, brand);
  const clipOk = opts.clips && found && (!found.text.includes("{brand}") || brand === DEFAULT_BRAND_NAME);
  if (found && clipOk) return { kind: "clip", script: found };
  const text = (req.text ?? (found ? withBrand(found.text, brand) : "")).trim();
  if (text && opts.tts && !opts.muted) return { kind: "tts", text: text.slice(0, 600) };
  return { kind: "none" };
}

/** Video sources for a clip name ("walk", or a script id), most capable first: transparent WebM, then MP4 on white or on the dark backdrop. */
export function clipSources(name: "walk" | ScriptId, dark: boolean): { src: string; type: string }[] {
  const base = `/assistant/elena-presenter-${name}`;
  return [
    { src: `${base}-alpha.webm`, type: "video/webm; codecs=vp9" },
    { src: dark ? `${base}-dark.mp4` : `${base}.mp4`, type: "video/mp4" },
  ];
}

/** Prefer a female English voice from the browser's list (the clips use a warm Australian/British-neutral female voice). */
export function pickVoice<T extends { lang: string; name: string }>(voices: readonly T[]): T | undefined {
  const en = voices.filter((v) => /^en(-|_|$)/i.test(v.lang));
  const female = /(female|natasha|catherine|karen|serena|susan|hazel|libby|sonia|jenny|aria|zira|samantha|moira|tessa|fiona|kate)/i;
  return en.find((v) => /^en[-_]au/i.test(v.lang) && female.test(v.name)) ?? en.find((v) => female.test(v.name)) ?? en.find((v) => /^en[-_]au/i.test(v.lang)) ?? en[0];
}
