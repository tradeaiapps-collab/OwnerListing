/**
 * Helpers that make Elena's spoken voice sound natural: text the browser reads aloud is tidied ("$650" becomes "650 dollars"),
 * cut into sentences so each gets its own breath and rise or fall, and the most natural installed voice is chosen.
 * Pure functions, so they are testable without a browser.
 */

/** Rewrite written shorthand the way a person would say it. */
export function forSpeech(text: string): string {
  return text
    .replace(/\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k|m)\b/gi, (_m, n: string, u: string) => `${n} ${u.toLowerCase() === "k" ? "thousand" : "million"} dollars`)
    .replace(/\$\s?(\d[\d,]*(?:\.\d+)?)/g, "$1 dollars")
    .replace(/\b(\d[\d,]*(?:\.\d+)?)\s*k\b/gi, "$1 thousand")
    .replace(/\b(\d+)\+\s*bedrooms?/gi, "$1 or more bedrooms")
    .replace(/\/\s*(?:wk|week)\b/gi, " a week")
    .replace(/\bp\/?w\b/gi, " a week")
    .replace(/\bQLD\b/g, "Queensland").replace(/\bNSW\b/g, "New South Wales").replace(/\bVIC\b/g, "Victoria")
    .replace(/\bSA\b/g, "South Australia").replace(/\bWA\b/g, "Western Australia").replace(/\bTAS\b/g, "Tasmania")
    .replace(/\bACT\b/g, "A.C.T.").replace(/\bNT\b/g, "Northern Territory")
    .replace(/\bAI\b/g, "A.I.")
    .replace(/["“”]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface SpeechChunk { text: string; /** Questions end on a rise. */ question: boolean; /** Pause before the next chunk, in ms. */ pause: number }

/** Split into sentences. Each is spoken on its own, which also avoids the browser cutting off long utterances. */
export function speechChunks(text: string): SpeechChunk[] {
  const parts = forSpeech(text).match(/[^.!?]+[.!?]*/g) ?? [];
  return parts.map(x => x.trim()).filter(x => /[a-z0-9]/i.test(x)).map(x => ({
    text: x.replace(/[.!?]+$/, x.endsWith("?") ? "?" : x.endsWith("!") ? "!" : "."),
    question: x.endsWith("?"),
    pause: x.endsWith("?") ? 0 : x.endsWith("!") ? 180 : 260
  }));
}

export interface VoiceLike { name: string; lang: string; localService?: boolean; default?: boolean }
const NATURAL = /natural|neural|premium|enhanced|online|google|siri/i;
const FEMALE = /female|karen|catherine|natasha|hayley|libby|sonia|samantha|serena|kate|susan|zira|aria|jenny|sara|tessa|moira|fiona|victoria|allison|ava/i;
const MALE = /\bmale\b|daniel|james|richard|george|david|mark|alex|fred|ryan|guy|tom\b/i;

/** Best English voice installed: Australian first, then British, then any English; natural-sounding and female-sounding ones win. */
export function pickVoice<T extends VoiceLike>(voices: readonly T[], lang = "en-AU"): T | undefined {
  const score = (v: T) => {
    const l = v.lang.replace("_", "-").toLowerCase();
    let s = 0;
    if (l === lang.toLowerCase()) s += 50; else if (l.startsWith("en-au")) s += 45; else if (l.startsWith("en-gb")) s += 30; else if (l.startsWith("en")) s += 20; else return -1;
    if (NATURAL.test(v.name)) s += 15;
    if (FEMALE.test(v.name)) s += 8;
    if (MALE.test(v.name)) s -= 8;
    if (v.default) s += 1;
    return s;
  };
  return [...voices].map(v => ({ v, s: score(v) })).filter(x => x.s >= 0).sort((a, b) => b.s - a.s)[0]?.v;
}
