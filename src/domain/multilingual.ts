import { BASE_SYSTEM_PROMPT, fenceData, isEngineUsable, type AiEnginePort } from "./ai-engine";
import { detectLanguage, type ChatLang } from "./language-detect";
import type { ChatTopic } from "./chat-assistant";

/**
 * Elena's languages. Translation is done by the self-hosted AI engine (no outside service), is always labelled machine
 * translation, and never replaces the English original, which stays the record. Without an engine she still understands the
 * main topics in every language (word lists below) and answers with a short note in the person's language plus the English answer.
 */
export interface ChatLanguage {
  code: ChatLang; name: string; english: string; rtl: boolean;
  /** BCP 47 tag for the browser's speech recognition and voice. */
  speech: string;
  /** How she should sound: used in the prompt for her own answers. */
  tone: string;
}

export const CHAT_LANGUAGES: readonly ChatLanguage[] = [
  { code: "en", name: "English", english: "English", rtl: false, speech: "en-AU", tone: "Plain, warm Australian English." },
  { code: "zh-Hans", name: "简体中文", english: "Simplified Chinese (Mandarin)", rtl: false, speech: "zh-CN", tone: "Polite and respectful. Address the person with 您. Be indirect rather than blunt about bad news. Write money as in the source (e.g. $1,250,000 or 125万澳元)." },
  { code: "zh-Hant", name: "繁體中文", english: "Traditional Chinese (Cantonese readers, Hong Kong and Taiwan usage)", rtl: false, speech: "zh-HK", tone: "Polite and respectful. Address the person with 您. Use Traditional characters and Hong Kong or Taiwan wording, not Mainland terms." },
  { code: "ar", name: "العربية", english: "Arabic (Modern Standard, readable by Lebanese, Iraqi and Egyptian speakers)", rtl: true, speech: "ar-SA", tone: "Courteous and formal, with a polite greeting where natural. Right-to-left; keep numbers and money as in the source." },
  { code: "fa", name: "فارسی", english: "Persian (Farsi)", rtl: true, speech: "fa-IR", tone: "Polite, using formal register (شما). Use the Persian zero-width non-joiner where correct." },
  { code: "vi", name: "Tiếng Việt", english: "Vietnamese", rtl: false, speech: "vi-VN", tone: "Respectful. Use 'quý khách' or 'anh/chị' to address the person, never 'mày'. Keep sentences clear and polite." },
  { code: "pa", name: "ਪੰਜਾਬੀ", english: "Punjabi (Gurmukhi script)", rtl: false, speech: "pa-IN", tone: "Warm and respectful. Use the polite 'ਤੁਸੀਂ' form. Gurmukhi script only." },
  { code: "hi", name: "हिन्दी", english: "Hindi (Devanagari script)", rtl: false, speech: "hi-IN", tone: "Respectful, using 'आप'. Plain everyday Hindi; keep common English property words (settlement, deposit) in Devanagari or English if clearer." },
  { code: "ta", name: "தமிழ்", english: "Tamil", rtl: false, speech: "ta-IN", tone: "Respectful and clear, using the polite plural form." },
  { code: "el", name: "Ελληνικά", english: "Greek", rtl: false, speech: "el-GR", tone: "Polite, using the formal plural (εσείς)." },
  { code: "it", name: "Italiano", english: "Italian", rtl: false, speech: "it-IT", tone: "Polite, using the formal 'Lei'." },
  { code: "es", name: "Español", english: "Spanish (neutral Latin American and Spanish)", rtl: false, speech: "es-ES", tone: "Polite, using the formal 'usted'." },
  { code: "tl", name: "Filipino", english: "Filipino (Tagalog)", rtl: false, speech: "fil-PH", tone: "Respectful: use 'po' and 'opo' and the plural 'kayo'." },
  { code: "ko", name: "한국어", english: "Korean", rtl: false, speech: "ko-KR", tone: "Polite formal speech level (합쇼체/해요체), never casual." }
];

export const CHAT_LANGUAGE_CODES: readonly ChatLang[] = CHAT_LANGUAGES.map(l => l.code);
export const languageInfo = (code: ChatLang): ChatLanguage => CHAT_LANGUAGES.find(l => l.code === code) ?? CHAT_LANGUAGES[0]!;
export const isChatLang = (v: unknown): v is ChatLang => typeof v === "string" && (CHAT_LANGUAGE_CODES as readonly string[]).includes(v);

/**
 * Fixed phrases in each language. They are drafted, not yet checked by a native speaker, so each language needs a person's review
 * before it is announced to users (docs/MULTILINGUAL.md). English is the master.
 */
export interface Phrases { welcome: (name: string) => string; englishBelow: string; machineNote: string }
export const PHRASES: Record<ChatLang, Phrases> = {
  en: { welcome: n => `Hi, I'm ${n}, the AI assistant for this conversation. I'm not a licensed agent, and I never accept or sign anything.`, englishBelow: "", machineNote: "Machine translation, for convenience. The English original applies." },
  "zh-Hans": { welcome: n => `您好，我是${n}，本次对话的 AI 助手。我可以用您的语言回复。我不是持牌经纪人，也绝不会代表任何人接受或签署任何内容。`, englishBelow: "我暂时无法翻译，以下是英文回答。", machineNote: "机器翻译，仅供参考。如有差异，以英文原文为准。" },
  "zh-Hant": { welcome: n => `您好，我是${n}，本次對話的 AI 助手。我可以用您的語言回覆。我不是持牌經紀人，也絕不會代表任何人接受或簽署任何內容。`, englishBelow: "我暫時無法翻譯，以下是英文回答。", machineNote: "機器翻譯，僅供參考。如有差異，以英文原文為準。" },
  ar: { welcome: n => `مرحبًا، أنا ${n}، المساعد الذكي لهذه المحادثة. يمكنني الرد بلغتك. لست وكيلًا مرخّصًا، ولن أقبل أو أوقّع أي شيء أبدًا.`, englishBelow: "لا أستطيع الترجمة الآن، لذا إجابتي بالإنجليزية أدناه.", machineNote: "ترجمة آلية للتيسير فقط. تسري النسخة الإنجليزية الأصلية." },
  fa: { welcome: n => `سلام، من ${n} هستم، دستیار هوش مصنوعی این گفتگو. می‌توانم به زبان شما پاسخ دهم. من کارگزار دارای مجوز نیستم و هرگز چیزی را نمی‌پذیرم یا امضا نمی‌کنم.`, englishBelow: "فعلاً نمی‌توانم ترجمه کنم، بنابراین پاسخ من در ادامه به انگلیسی است.", machineNote: "ترجمهٔ ماشینی، فقط برای راحتی. در صورت تفاوت، متن اصلی انگلیسی معتبر است." },
  vi: { welcome: n => `Xin chào, tôi là ${n}, trợ lý AI của cuộc trò chuyện này. Tôi có thể trả lời bằng ngôn ngữ của bạn. Tôi không phải là môi giới có giấy phép và sẽ không bao giờ chấp nhận hay ký bất cứ điều gì.`, englishBelow: "Hiện tôi chưa thể dịch, nên câu trả lời bằng tiếng Anh ở bên dưới.", machineNote: "Bản dịch máy, chỉ để tham khảo. Nếu có khác biệt, bản gốc tiếng Anh được áp dụng." },
  pa: { welcome: n => `ਸਤ ਸ੍ਰੀ ਅਕਾਲ, ਮੈਂ ${n} ਹਾਂ, ਇਸ ਗੱਲਬਾਤ ਦੀ AI ਸਹਾਇਕ। ਮੈਂ ਤੁਹਾਡੀ ਭਾਸ਼ਾ ਵਿੱਚ ਜਵਾਬ ਦੇ ਸਕਦੀ ਹਾਂ। ਮੈਂ ਲਾਇਸੰਸਸ਼ੁਦਾ ਏਜੰਟ ਨਹੀਂ ਹਾਂ ਅਤੇ ਕਦੇ ਵੀ ਕੁਝ ਮਨਜ਼ੂਰ ਜਾਂ ਦਸਤਖ਼ਤ ਨਹੀਂ ਕਰਦੀ।`, englishBelow: "ਮੈਂ ਹੁਣ ਅਨੁਵਾਦ ਨਹੀਂ ਕਰ ਸਕਦੀ, ਇਸ ਲਈ ਮੇਰਾ ਜਵਾਬ ਹੇਠਾਂ ਅੰਗਰੇਜ਼ੀ ਵਿੱਚ ਹੈ।", machineNote: "ਮਸ਼ੀਨੀ ਅਨੁਵਾਦ, ਸਿਰਫ਼ ਸਹੂਲਤ ਲਈ। ਫ਼ਰਕ ਹੋਵੇ ਤਾਂ ਅੰਗਰੇਜ਼ੀ ਮੂਲ ਲਾਗੂ ਹੋਵੇਗਾ।" },
  hi: { welcome: n => `नमस्ते, मैं ${n} हूँ, इस बातचीत की AI सहायक। मैं आपकी भाषा में जवाब दे सकती हूँ। मैं लाइसेंसशुदा एजेंट नहीं हूँ और कभी कुछ स्वीकार या हस्ताक्षर नहीं करती।`, englishBelow: "मैं अभी अनुवाद नहीं कर सकती, इसलिए मेरा उत्तर नीचे अंग्रेज़ी में है।", machineNote: "मशीनी अनुवाद, केवल सुविधा के लिए। अंतर होने पर अंग्रेज़ी मूल लागू होगा।" },
  ta: { welcome: n => `வணக்கம், நான் ${n}, இந்த உரையாடலின் AI உதவியாளர். உங்கள் மொழியில் பதிலளிக்க முடியும். நான் உரிமம் பெற்ற முகவர் அல்ல; எதையும் ஏற்கவோ கையொப்பமிடவோ மாட்டேன்.`, englishBelow: "இப்போது மொழிபெயர்க்க முடியவில்லை, எனவே என் பதில் கீழே ஆங்கிலத்தில் உள்ளது.", machineNote: "இயந்திர மொழிபெயர்ப்பு, வசதிக்காக மட்டும். வேறுபாடு இருந்தால் ஆங்கில மூலமே செல்லுபடியாகும்." },
  el: { welcome: n => `Γεια σας, είμαι η ${n}, η βοηθός τεχνητής νοημοσύνης αυτής της συνομιλίας. Μπορώ να απαντώ στη γλώσσα σας. Δεν είμαι αδειοδοτημένη μεσίτρια και δεν αποδέχομαι ούτε υπογράφω ποτέ τίποτα.`, englishBelow: "Δεν μπορώ να μεταφράσω αυτή τη στιγμή, γι' αυτό η απάντησή μου είναι παρακάτω στα αγγλικά.", machineNote: "Αυτόματη μετάφραση, για διευκόλυνση. Σε περίπτωση διαφοράς ισχύει το αγγλικό πρωτότυπο." },
  it: { welcome: n => `Buongiorno, sono ${n}, l'assistente AI di questa conversazione. Posso rispondere nella sua lingua. Non sono un agente con licenza e non accetto né firmo mai nulla.`, englishBelow: "Al momento non posso tradurre, quindi la mia risposta è in inglese qui sotto.", machineNote: "Traduzione automatica, solo per comodità. In caso di differenze prevale l'originale inglese." },
  es: { welcome: n => `Hola, soy ${n}, la asistente de IA de esta conversación. Puedo responder en su idioma. No soy una agente con licencia y nunca acepto ni firmo nada.`, englishBelow: "Ahora mismo no puedo traducir, así que mi respuesta está en inglés más abajo.", machineNote: "Traducción automática, solo por comodidad. Si hay diferencias, prevalece el original en inglés." },
  tl: { welcome: n => `Kumusta po, ako si ${n}, ang AI assistant ng usapang ito. Puwede akong sumagot sa wika ninyo. Hindi ako lisensyadong ahente at hindi ako kailanman tumatanggap o pumipirma ng anuman.`, englishBelow: "Hindi pa ako makapagsalin ngayon, kaya nasa Ingles ang sagot ko sa ibaba.", machineNote: "Salin ng makina, para sa kaginhawaan lamang. Kung may pagkakaiba, ang orihinal na Ingles ang masusunod." },
  ko: { welcome: n => `안녕하세요, 저는 이 대화의 AI 어시스턴트 ${n}입니다. 사용자의 언어로 답변드릴 수 있습니다. 저는 면허가 있는 중개인이 아니며, 어떤 것도 수락하거나 서명하지 않습니다.`, englishBelow: "지금은 번역할 수 없어 아래에 영어로 답변드립니다.", machineNote: "편의를 위한 기계 번역입니다. 차이가 있으면 영어 원문이 우선합니다." }
};

// ---- Understanding questions without an engine ----
// First match wins, so the narrower topics come first. Words are matched as lower-case substrings.
const LEXICON: readonly [Exclude<ChatTopic, "welcome" | "privacy" | "advice" | "unknown">, readonly string[], string][] = [
  ["compromise", ["折中", "妥协", "妥協", "讓步", "让步", "thỏa hiệp", "nhượng bộ", "حل وسط", "تنازل", "سازش", "समझौता", "ਸਮਝੌਤਾ", "சமரசம்", "συμβιβασμ", "compromesso", "compromiso", "punto medio", "kompromiso", "타협", "절충"], "Can you suggest a compromise?"],
  ["next_steps", ["下一步", "接下来", "接下來", "bước tiếp theo", "tiếp theo", "الخطوة التالية", "الخطوات التالية", "ماذا بعد", "گام بعدی", "مرحله بعد", "अगला कदम", "आगे क्या", "ਅਗਲਾ ਕਦਮ", "அடுத்த படி", "επόμενα βήματα", "επόμενο βήμα", "prossimi passi", "prossimo passo", "siguientes pasos", "próximo paso", "susunod na hakbang", "다음 단계"], "What are the next steps?"],
  ["settlement", ["交割", "过户", "過戶", "交房", "hoàn tất giao dịch", "bàn giao", "التسوية", "تسليم", "تسویه", "تحویل", "निपटान", "सेटलमेंट", "ਸੈਟਲਮੈਂਟ", "தீர்வு", "διακανονισμ", "rogito", "consegna", "cierre", "escritura", "entrega", "turnover", "잔금", "입주"], "How long is the settlement?"],
  ["deposit", ["订金", "定金", "訂金", "按金", "首付", "đặt cọc", "tiền cọc", "عربون", "وديعة", "بیعانه", "ودیعه", "डिपॉज़िट", "बयाना", "जमा राशि", "ਡਿਪਾਜ਼ਿਟ", "டெபாசிட்", "வைப்பு", "προκαταβολ", "caparra", "deposito", "depósito", "arras", "paunang bayad", "계약금", "보증금"], "How much is the deposit?"],
  ["conditions", ["条件", "條件", "điều kiện", "شروط", "شرایط", "शर्त", "ਸ਼ਰਤ", "நிபந்தனை", "όροι", "προϋποθέσεις", "condizioni", "clausole", "condiciones", "cláusulas", "kondisyon", "조건"], "What are the conditions?"],
  ["market", ["市场", "市場", "行情", "thị trường", "السوق", "بازار", "बाज़ार", "मार्केट", "ਬਾਜ਼ਾਰ", "சந்தை", "αγορά", "mercato", "quartiere", "mercado", "barrio", "merkado", "시장", "시세"], "How is the market in this area?"],
  ["offer", ["出价", "出價", "报价", "報價", "还价", "還價", "giá", "đề nghị", "عرض", "سعر", "پیشنهاد", "قیمت", "ऑफर", "प्रस्ताव", "कीमत", "दाम", "ਪੇਸ਼ਕਸ਼", "ਕੀਮਤ", "சலுகை", "விலை", "προσφορά", "τιμή", "offerta", "prezzo", "oferta", "precio", "alok", "presyo", "제안", "가격", "kitna", "kimat"], "What is the status of the offer?"],
  ["listing", ["房源", "房产", "房產", "房屋", "物业", "物業", "房子", "căn nhà", "bất động sản", "ngôi nhà", "العقار", "المنزل", "ملک", "خانه", "घर", "मकान", "संपत्ति", "ਘਰ", "ਜਾਇਦਾਦ", "வீடு", "சொத்து", "σπίτι", "ακίνητο", "casa", "immobile", "annuncio", "propiedad", "inmueble", "bahay", "매물", "부동산"], "Tell me about the listing."],
  ["chitchat", ["你好", "您好", "谢谢", "謝謝", "xin chào", "cảm ơn", "مرحبا", "شكرا", "السلام عليكم", "سلام", "ممنون", "نمنون", "नमस्ते", "धन्यवाद", "शुक्रिया", "ਸਤ ਸ੍ਰੀ ਅਕਾਲ", "ਧੰਨਵਾਦ", "வணக்கம்", "நன்றி", "γεια", "ευχαριστώ", "ciao", "buongiorno", "grazie", "hola", "gracias", "kumusta", "salamat", "안녕", "감사"], "Hello"]
];

/** A plain English question for the topic a non-English question is about, or undefined when no topic word is found. */
export function englishQuestionFor(question: string): { topic: ChatTopic; english: string } | undefined {
  const q = question.toLowerCase().normalize("NFC");
  for (const [topic, words, english] of LEXICON) if (words.some(w => q.includes(w))) return { topic, english };
  return undefined;
}

// ---- Translation pipeline ----
const CONTACT_TOKEN = /https?:\/\/\S+|www\.\S+|[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}|(?:\+?61|\b0)[\s-]?\d(?:[\s-]?\d){7,9}/g;
const MONEY_TOKEN = /(?:A\$|AUD\s?|\$)\s?\d[\d,]*(?:\.\d+)?\s?(?:[kKmM]\b)?/g;
const NUMBER_TOKEN = /\d[\d,.]*\d|\d/g;
const PH = /⟦(\d+)⟧/g;

export interface Protected { text: string; tokens: string[] }

/**
 * Swaps things a translation must never change (contact details, money, every number, and the given names/addresses) for
 * numbered placeholders. After translating, each placeholder must come back exactly once or the result is rejected.
 */
export function protectTokens(text: string, keep: readonly string[] = []): Protected {
  const tokens: string[] = [];
  const hold = (m: string) => `⟦${tokens.push(m) - 1}⟧`;
  let t = text;
  for (const k of [...keep].filter(x => x.trim().length >= 3).sort((a, b) => b.length - a.length)) t = t.split(k).join(hold(k));
  // Placeholders already in the text are not touched again (the digits inside them must not be matched).
  const apply = (re: RegExp) => { t = t.split(/(⟦\d+⟧)/).map(part => (/^⟦\d+⟧$/.test(part) ? part : part.replace(re, hold))).join(""); };
  apply(CONTACT_TOKEN); apply(MONEY_TOKEN); apply(NUMBER_TOKEN);
  return { text: t, tokens };
}

export function restoreTokens(text: string, tokens: readonly string[]): string {
  return text.replace(PH, (_m, i: string) => tokens[Number(i)] ?? "");
}

const placeholdersOf = (s: string) => (s.match(PH) ?? []).sort().join(",");

interface Segment { prefix: string; body: string; suffix: string }
const PREFIX_RE = /^(\s*(?:#{1,6}\s+|[-*•>]+\s+|\d+[.)]\s+|\(?[a-z]\)\s+)?)/i;

/** Splits text into lines and table cells, keeping indentation, bullets, numbering, headings and blank lines exactly as they were. */
function segmentLines(text: string): (Segment | string)[][] {
  return text.replace(/\r\n?/g, "\n").split("\n").map(line => {
    if (line.trim() === "") return [line];
    if (/^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-")) return [line]; // table rule row
    if (line.includes("|")) {
      return line.split("|").map((cell, i, all): Segment | string => {
        const lead = /^\s*/.exec(cell)![0]; const trail = /\s*$/.exec(cell)![0];
        const body = cell.trim();
        const seg: Segment = { prefix: lead, body, suffix: trail + (i < all.length - 1 ? "|" : "") };
        return body === "" ? lead + trail + (i < all.length - 1 ? "|" : "") : seg;
      });
    }
    const prefix = PREFIX_RE.exec(line)![1] ?? "";
    return [{ prefix, body: line.slice(prefix.length), suffix: "" } satisfies Segment];
  });
}

const hasLetters = (s: string) => /\p{L}/u.test(s.replace(PH, ""));

export interface TranslateOptions {
  engine: AiEnginePort; from: ChatLang; to: ChatLang;
  /** "assistant" lets her tone follow the language's politeness norms; "faithful" keeps the writer's own tone (messages and documents). */
  register: "assistant" | "faithful";
  /** Names and addresses that must stay as written. */
  keep?: readonly string[];
  maxTokens?: number;
}
export interface TranslateResult { text: string; translatedSegments: number; totalSegments: number; complete: boolean }

function systemFor(o: TranslateOptions): string {
  const to = languageInfo(o.to); const from = languageInfo(o.from);
  return [
    BASE_SYSTEM_PROMPT,
    `Task: translate from ${from.english} into ${to.english}. Translate faithfully: do not add, remove, soften, explain or advise.`,
    "Every line starts with a label like [[3]]. Reply with the same labels, one per line, each followed by that line's translation. Never merge or split lines.",
    "Symbols like ⟦0⟧ are fixed values. Copy each one unchanged, exactly once, in the right place in the sentence.",
    o.register === "assistant" ? `Voice: ${to.tone}` : "Keep the writer's own tone, politeness and meaning. Do not make it more or less polite or firm."
  ].join("\n");
}

/** Does this text look like the target language? Catches an engine that ignored the instruction and answered in English. */
export function looksLike(lang: ChatLang, text: string): boolean {
  const body = text.replace(PH, " ");
  if (!/\p{L}/u.test(body)) return true;
  const d = detectLanguage(body);
  const family = (l: ChatLang) => (l === "zh-Hans" || l === "zh-Hant" ? "zh" : l === "ar" || l === "fa" ? "arab" : l);
  const letters = body.match(/\p{L}/gu) ?? [];
  const nonLatin = letters.filter(c => !/\p{Script=Latin}/u.test(c)).length;
  if (lang === "en") return nonLatin / letters.length < 0.02;
  const latinTarget = ["vi", "it", "es", "tl"].includes(lang);
  if (latinTarget) return nonLatin / letters.length < 0.3 && ( d.lang !== "en" || d.confidence < 0.6 || /[ăâđêôơưàáèéìíòóùúñ]/i.test(body) || body.length < 25);
  return family(d.lang) === family(lang);
}

async function runBatch(o: TranslateOptions, items: { id: number; body: string }[]): Promise<Map<number, string> | undefined> {
  const prompt = `${items.map(i => `[[${i.id}]] ${i.body.replace(/\n/g, " ")}`).join("\n")}`;
  let out: string;
  try {
    out = await o.engine.generate(`Translate these lines.\n${fenceData(prompt, 12000)}`, { system: systemFor(o), maxTokens: o.maxTokens ?? 3000 });
  } catch { return undefined; }
  const got = new Map<number, string>();
  for (const line of out.split("\n")) {
    const m = /^\s*\[\[(\d+)\]\]\s?(.*)$/.exec(line);
    if (m) got.set(Number(m[1]), m[2] ?? "");
  }
  const ok = items.every(i => {
    const t = got.get(i.id);
    return t !== undefined && t.trim() !== "" && placeholdersOf(t) === placeholdersOf(i.body) && looksLike(o.to, t);
  });
  return ok ? got : undefined;
}

/**
 * Translates text and keeps its shape: line breaks, blank lines, indentation, bullets, numbering, headings and table cells stay as
 * they were, and numbers, money, contact details and the names in `keep` come back exactly. A batch that fails any check is split
 * and retried; a line that still fails stays in the original language, and `complete` is false so the caller can say so.
 */
export async function translateText(text: string, o: TranslateOptions): Promise<TranslateResult> {
  if (o.from === o.to || !isEngineUsable(o.engine)) return { text, translatedSegments: 0, totalSegments: 0, complete: o.from === o.to };
  const lines = segmentLines(text);
  // Protect per segment but share one token table, so placeholders are unique across the document.
  const tokens: string[] = [];
  const work: { id: number; seg: Segment; body: string }[] = [];
  const parsed = lines.map(cells => cells.map(c => {
    if (typeof c === "string") return c;
    const p = protectTokens(c.body, o.keep);
    const shift = tokens.length;
    tokens.push(...p.tokens);
    const body = shift === 0 ? p.text : p.text.replace(PH, (_m, i: string) => `⟦${Number(i) + shift}⟧`);
    if (!hasLetters(body)) return c.prefix + restoreTokens(body, tokens) + c.suffix;
    const id = work.length;
    work.push({ id, seg: c, body });
    return id;
  }));
  const result = new Map<number, string>();
  const BATCH = 25;
  const solve = async (items: typeof work): Promise<void> => {
    if (items.length === 0) return;
    const got = await runBatch(o, items.map(i => ({ id: i.id, body: i.body })));
    if (got) { for (const i of items) result.set(i.id, got.get(i.id)!); return; }
    if (items.length === 1) return;
    const mid = Math.ceil(items.length / 2);
    await solve(items.slice(0, mid)); await solve(items.slice(mid));
  };
  for (let i = 0; i < work.length; i += BATCH) await solve(work.slice(i, i + BATCH));

  const lineOut = parsed.map(cells => cells.map(c => {
    if (typeof c === "string") return c;
    const w = work[c]!;
    const t = result.get(c);
    return w.seg.prefix + restoreTokens(t ?? w.body, tokens) + w.seg.suffix;
  }).join(""));
  return { text: lineOut.join("\n"), translatedSegments: result.size, totalSegments: work.length, complete: result.size === work.length };
}

// ---- Documents ----
export const DOCUMENT_KINDS = ["offer", "contract", "inspection", "other"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
export const MAX_DOCUMENT_CHARS = 30000;

/** Translated offers, contracts and inspection reports are for understanding only: the English text is the one that applies. */
export function documentNotice(to: ChatLang): string {
  const p = PHRASES[to];
  return to === "en" ? PHRASES.en.machineNote : p.machineNote;
}
