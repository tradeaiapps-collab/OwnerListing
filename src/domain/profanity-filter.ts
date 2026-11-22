/**
 * Language check for public-facing free text (photo captions, screen-reader descriptions, feature tags): swearing,
 * abuse, racist and other slurs, threats, and their shorthand (wtf, stfu, kys, f**k, sh1t, a$$, "f u c k").
 * Pure, rules only. Whole-word matching after folding case, accents, letter swaps and stretched letters, so words such as
 * "class" or "Scunthorpe" are not hit. It advises: the owner may override for legitimate uses (a product or street name).
 * The lists are a starting map and are meant to be extended.
 */

export const PROFANITY_MESSAGE = "Description contains inappropriate language. Please revise before posting.";

const WORDS: readonly string[] = [
  // swearing
  "fuck", "fucking", "fucked", "fucker", "fuckers", "fuckin", "motherfucker", "mofo", "fck", "fuk", "fuq", "fk", "fcuk", "fking", "fkn",
  "shit", "shitty", "shite", "bullshit", "bs", "sht", "shyt", "bitch", "bitches", "biatch", "bastard", "ass", "asshole", "arse", "arsehole",
  "dick", "dickhead", "cock", "cunt", "cunts", "pussy", "piss", "pissed", "wanker", "twat", "prick", "bollocks", "crap", "damn", "goddamn",
  "slut", "whore", "hoe", "porn", "porno", "boob", "boobs", "tits", "wtf", "stfu", "gtfo", "pos", "lmfao", "milf",
  // abuse
  "idiot", "idiots", "moron", "morons", "imbecile", "scumbag", "dumbass", "jackass", "loser", "pathetic", "retard", "retarded", "spastic",
  // racist, homophobic and other slurs
  "nigger", "niggers", "nigga", "niga", "n1gger", "faggot", "fag", "fags", "dyke", "tranny", "chink", "gook", "kike", "wog", "wop",
  "paki", "coon", "raghead", "towelhead", "beaner", "wetback", "abo", "darkie", "jap", "negro", "gypsy",
  // threats and self-harm shorthand
  "kys", "kms"
];
const SET = new Set(WORDS);
const BY_LENGTH = new Map<number, string[]>();
for (const w of WORDS) BY_LENGTH.set(w.length, [...(BY_LENGTH.get(w.length) ?? []), w]);

/** Phrases (matched on folded text) for threats, abuse and hate. */
const PHRASES: readonly RegExp[] = [
  /\b(i|we|ill|i will|i'?m going to|im gonna|gonna|going to) (kill|hurt|find|destroy|bash|stab|shoot|burn|rape|murder|get|end|beat) (you|u|him|her|them|ya)\b/,
  /\b(kill|hurt|murder|shoot|stab|rape|beat|bash) (yourself|urself|ur self|you|u|them|him|her|everyone)\b/,
  /\bgo (die|kill yourself|to hell|back to)\b/,
  /\b(you|u|they|he|she) (should|ought to|better|need to) (die|rot|burn|disappear)\b/,
  /\b(burn|blow) (it|this|that|the (house|place|building)) (down|up)\b/,
  /\b(watch|look) (your|ur) back\b/,
  /\bor else\b/,
  /\bdeath to\b/,
  /\bkill (all|every)\w*\b/,
  /\b(shut|fuck|piss|bugger|screw|rack) (up|off|you|u|ya)\b/,
  /\bson of a (bitch|whore|gun)\b/,
  /\b(white|black|asian|brown|yellow) (trash|scum|filth)\b/,
  /\b(go|get) back to (your|ur|where)\b/,
  /\bno (blacks?|asians?|aboriginals?|indians?|muslims?|jews?|gays?)\b/
];

function fold(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ\p{Cf}]/gu, "").toLowerCase()
    .replace(/[0134578]/g, c => ({ "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b" } as Record<string, string>)[c]!)
    .replace(/(?<=\p{L})[@$!](?=\p{L})/gu, c => ({ "@": "a", "$": "s", "!": "i" } as Record<string, string>)[c]!)
    .replace(/(\p{L})\1{2,}/gu, "$1");
}

/** Wildcard tokens (f**k, sh*t, a$$) match a word of the same length where each wildcard is one letter. */
function wildcardHit(token: string): string | null {
  const pattern = new RegExp(`^${token.replace(/[*#%$@!]/g, "\u0000").replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\u0000/g, "\\p{L}")}$`, "u");
  return (BY_LENGTH.get([...token].length) ?? []).find(w => pattern.test(w)) ?? null;
}

/** The offending words and phrases found in `text` (lower case, de-duplicated). Empty when the text is clean. */
export function findProfanity(text: string): string[] {
  if (!text) return [];
  const folded = fold(text).replace(/\s+/g, " ");
  const hits = new Set<string>();
  for (const t of folded.split(/[^\p{L}*#%$@!]+/u)) {
    const bare = t.replace(/^[*#%$@!]+|[!]+$/gu, (m) => (/^[*#%$@!]*$/.test(m) && m.length === t.length ? m : ""));
    if (!bare) continue;
    if (SET.has(bare)) hits.add(bare);
    else if (/[*#%$@!]/.test(bare) && /\p{L}/u.test(bare)) { const w = wildcardHit(bare); if (w) hits.add(w); }
  }
  // Letters spaced out or dotted to dodge the list ("f u c k", "f.u.c.k").
  for (const s of folded.match(/(?<![\p{L}])(?:\p{L}[\s.\-_]){2,}\p{L}(?![\p{L}])/gu) ?? []) {
    const j = s.replace(/[^\p{L}]/gu, "");
    if (SET.has(j)) hits.add(j);
  }
  for (const re of PHRASES) { const m = folded.match(re); if (m) hits.add(m[0]); }
  return [...hits];
}

export const hasProfanity = (...texts: readonly string[]): boolean => texts.some(t => findProfanity(t).length > 0);
