/**
 * Rule-based check that free text is a real description (no AI). Pure and client-safe.
 * Catches keyboard mash, repeated characters, words with no vowels, one word repeated and text that is too short to describe anything.
 * Blank text passes here: whether a description is required is decided elsewhere.
 */
export const GIBBERISH_MESSAGE = "Please write a real description.";

const VOWELS = new Set("aeiouy");
const ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
const MASH = new Set<string>();
for (const row of ROWS) for (const r of [row, [...row].reverse().join("")]) for (let i = 0; i + 5 <= r.length; i++) MASH.add(r.slice(i, i + 5));

/** Labelled sentences Elena writes from the owner's answers. Each one is checked on its own. */
const LABELLED = /(Outdoors|Recent work|Nearby):\s*([^\n]*)/g;

const wordsOf = (t: string) => t.toLowerCase().match(/[a-z]+/g) ?? [];

/** A single word that cannot be English: no vowels, a long run of consonants, a repeated letter run or a keyboard row. */
function badWord(w: string): boolean {
  if (/(.)\1{3,}/.test(w)) return true;
  if (w.length >= 4 && ![...w].some(c => VOWELS.has(c))) return true;
  if (/[^aeiouy]{6,}/.test(w)) return true;
  if (w.length >= 5) for (let i = 0; i + 5 <= w.length; i++) if (MASH.has(w.slice(i, i + 5))) return true;
  return false;
}

function segmentLooksFake(text: string, minWords: number): boolean {
  const words = wordsOf(text);
  if (words.length < minWords) return true;
  if (words.length === 0) return false;
  const bad = words.filter(badWord).length;
  if (bad > 0 && (bad >= 2 || bad / words.length >= 0.25)) return true;
  if (words.length >= 6 && new Set(words).size / words.length < 0.4) return true;
  const letters = words.join("");
  if (letters.length >= 8) {
    const ratio = [...letters].filter(c => VOWELS.has(c)).length / letters.length;
    if (ratio < 0.2 || ratio > 0.7) return true;
  }
  return false;
}

/** Null when the text is blank or reads like real writing, otherwise the message to show the owner. */
/** `minWords` is 2 on the form and at publish; a draft save passes 1 so a short note can be saved. */
export function checkRealText(text: string | null | undefined, minWords = 2): string | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  const rest = t.replace(LABELLED, "").trim();
  if (rest && segmentLooksFake(rest, minWords)) return GIBBERISH_MESSAGE;
  for (const m of t.matchAll(LABELLED)) if (m[2]!.trim() && segmentLooksFake(m[2]!, minWords)) return `${GIBBERISH_MESSAGE} Check the "${m[1]}" part.`;
  return null;
}
