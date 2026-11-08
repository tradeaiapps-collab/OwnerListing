/**
 * Language detection for chat text, with no outside service. Script first (it settles most languages on its own),
 * then small word lists for languages that share a script (Latin, Arabic script, Han). Pure and deterministic.
 * Short or mixed text gets a low confidence; callers fall back to the person's saved language when confidence is low.
 */
export type ChatLang = "en" | "zh-Hans" | "zh-Hant" | "ar" | "fa" | "vi" | "pa" | "hi" | "ta" | "el" | "it" | "es" | "tl" | "ko";

export interface Detected {
  lang: ChatLang;
  /** 0 to 1. Below MIN_CONFIDENCE the result is a guess. */
  confidence: number;
  /** Spoken variety when it matters for tone and voice: Cantonese written in Traditional Chinese, or Hindi typed in Latin letters. */
  dialect?: "yue" | "romanised";
}

export const MIN_CONFIDENCE = 0.6;
const DEFAULT: Detected = { lang: "en", confidence: 0.3 };

const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;
const words = (s: string) => s.toLowerCase().normalize("NFC").match(/[\p{L}\p{M}']+/gu) ?? [];

// Characters that only exist (or are normal) in one of the two Chinese scripts.
const SIMPLIFIED = /[们订这个为说时会发对过后来还没关开见现应进长问间书车东门马鸟鱼钱银买卖读写听语请谢图专业产价楼层卫厅预约经济银贷款税务]/g;
const TRADITIONAL = /[們訂這個為說時會發對過後來還沒關開見現應進長問間書車東門馬鳥魚錢銀買賣讀寫聽語請謝圖專業產價樓層衛廳預約經濟貸款稅務]/g;
// Colloquial written Cantonese.
const CANTONESE = /[嘅咗唔係冇哋佢啲嚟喺嘢咁睇]/g;
// Letters that tell Persian and Urdu apart from Arabic.
const PERSIAN = /[پچژگ]/g;
const URDU = /[ٹڈڑںےھ]/g;
const VI_MARKS = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/gi;

const STOP: Record<"en" | "es" | "it" | "tl" | "vi" | "hiRoman", readonly string[]> = {
  en: ["the", "and", "is", "are", "what", "how", "can", "you", "i", "we", "my", "this", "that", "for", "with", "it", "do", "does", "about", "have", "offer", "price", "please", "hi", "hello", "thanks", "of", "to", "in", "on", "a", "me", "when", "will"],
  es: ["el", "la", "los", "las", "de", "que", "y", "es", "en", "un", "una", "por", "para", "con", "cuánto", "cuanto", "cómo", "como", "hola", "gracias", "quiero", "puedo", "mi", "oferta", "precio", "casa", "qué", "se", "del", "al", "está", "esta", "tengo"],
  it: ["il", "lo", "la", "gli", "le", "di", "che", "e", "è", "in", "un", "una", "per", "con", "come", "quanto", "ciao", "grazie", "vorrei", "posso", "mia", "offerta", "prezzo", "casa", "cosa", "del", "della", "sono", "ho", "non", "buongiorno"],
  tl: ["ang", "ng", "sa", "mga", "ko", "ako", "ikaw", "po", "opo", "salamat", "magkano", "paano", "ano", "bahay", "gusto", "namin", "natin", "kayo", "hindi", "oo", "mo", "ito", "iyan", "kumusta", "pwede", "puwede", "alok"],
  vi: ["tôi", "bạn", "không", "có", "là", "và", "của", "giá", "nhà", "xin", "chào", "cảm", "ơn", "bao", "nhiêu", "muốn", "thế", "nào", "được", "một", "các", "này"],
  hiRoman: ["mujhe", "hai", "kya", "aap", "nahi", "nahin", "ghar", "kitna", "kitne", "chahiye", "kaise", "mera", "meri", "hum", "main", "bhai", "namaste", "dhanyavad", "shukriya", "kab", "aur", "ka", "ki", "ke", "se", "mein", "karna", "karo", "kar", "sakta", "sakti"]
};

function score(ws: readonly string[], list: readonly string[]): number {
  const set = new Set(list);
  return ws.reduce((n, w) => n + (set.has(w) ? 1 : 0), 0);
}

function latin(text: string): Detected {
  const ws = words(text);
  if (ws.length === 0) return DEFAULT;
  const vi = count(text, VI_MARKS);
  const viScore = score(ws, STOP.vi) + (vi >= 2 || (vi >= 1 && ws.length <= 6) ? 2 : 0);
  const scores: [ChatLang | "hiRoman", number][] = [
    ["en", score(ws, STOP.en)], ["es", score(ws, STOP.es) + count(text, /[¿¡ñ]/g)], ["it", score(ws, STOP.it) + count(text, /\b\w+(zione|mente)\b/gi) * 0.5],
    ["tl", score(ws, STOP.tl)], ["vi", viScore], ["hiRoman", score(ws, STOP.hiRoman)]
  ];
  scores.sort((a, b) => b[1] - a[1]);
  const [best, second] = [scores[0]!, scores[1]!];
  if (best[1] === 0) return { lang: "en", confidence: 0.35 };
  // Confidence grows with the margin over the runner-up and with how much of the text matched.
  const share = best[1] / ws.length;
  const confidence = Math.min(0.99, 0.35 + (best[1] - second[1]) * 0.18 + share * 0.5);
  if (best[0] === "hiRoman") return { lang: "hi", confidence, dialect: "romanised" };
  return { lang: best[0], confidence };
}

function arabicScript(text: string): Detected {
  const fa = count(text, PERSIAN);
  const ur = count(text, URDU);
  if (fa > 0 && fa >= ur) return { lang: "fa", confidence: Math.min(0.97, 0.7 + fa * 0.08) };
  // Urdu is not a chat language yet; Arabic-script text with Urdu letters is closest to Persian/Arabic readers, so it is a low-confidence guess.
  if (ur > 0) return { lang: "ar", confidence: 0.4 };
  return { lang: "ar", confidence: 0.95 };
}

function han(text: string): Detected {
  const yue = count(text, CANTONESE);
  const s = count(text, SIMPLIFIED);
  const t = count(text, TRADITIONAL);
  if (yue > 0) return { lang: "zh-Hant", confidence: Math.min(0.97, 0.75 + yue * 0.05), dialect: "yue" };
  if (s > t) return { lang: "zh-Hans", confidence: Math.min(0.97, 0.7 + (s - t) * 0.08) };
  if (t > s) return { lang: "zh-Hant", confidence: Math.min(0.97, 0.7 + (t - s) * 0.08) };
  // Only characters shared by both scripts: Mandarin in Simplified is the commoner default in Australia, but it is a guess.
  return { lang: "zh-Hans", confidence: 0.7 };
}

/** The language of a piece of text. Text with no letters returns English at low confidence. */
export function detectLanguage(raw: string): Detected {
  const text = raw.normalize("NFC").replace(/https?:\/\/\S+|[\w.+-]+@[\w.-]+/g, " ");
  // Count letters by script and take the script that dominates; numbers and punctuation are ignored.
  const kana = count(text, /[぀-ヿ]/gu);
  const scripts: [string, number][] = [
    ["han", count(text, /\p{Script=Han}/gu)], ["hangul", count(text, /\p{Script=Hangul}/gu)], ["arabic", count(text, /\p{Script=Arabic}/gu)],
    ["devanagari", count(text, /\p{Script=Devanagari}/gu)], ["gurmukhi", count(text, /\p{Script=Gurmukhi}/gu)], ["tamil", count(text, /\p{Script=Tamil}/gu)],
    ["greek", count(text, /\p{Script=Greek}/gu)], ["latin", count(text, /\p{Script=Latin}/gu)]
  ];
  scripts.sort((a, b) => b[1] - a[1]);
  const [top, n] = scripts[0]!;
  if (n === 0 || kana > 0) return DEFAULT;
  switch (top) {
    case "han": return han(text);
    case "hangul": return { lang: "ko", confidence: 0.98 };
    case "arabic": return arabicScript(text);
    case "devanagari": return { lang: "hi", confidence: 0.9 };
    case "gurmukhi": return { lang: "pa", confidence: 0.98 };
    case "tamil": return { lang: "ta", confidence: 0.98 };
    case "greek": return { lang: "el", confidence: 0.98 };
    default: return latin(text);
  }
}

/**
 * The language to answer in. A language the person chose themselves always wins. In auto mode a confident reading of the message wins,
 * otherwise the last language seen from them, otherwise English. (Short messages like "ok" must not flip the language.)
 */
export function chooseReplyLanguage(input: { chosen?: ChatLang | undefined; lastDetected?: ChatLang | undefined; detected: Detected }): ChatLang {
  const { chosen, lastDetected, detected } = input;
  if (chosen !== undefined) return chosen;
  if (detected.confidence >= MIN_CONFIDENCE) return detected.lang;
  return lastDetected ?? "en";
}
