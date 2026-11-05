import { describe, expect, it } from "vitest";
import { chooseReplyLanguage, detectLanguage, MIN_CONFIDENCE } from "../src/domain/language-detect";

describe("detectLanguage", () => {
  it.each([
    ["What is the settlement period for this house?", "en"],
    ["这套房子的交割期是多久？我想了解一下出价。", "zh-Hans"],
    ["呢間屋嘅訂金係幾多？唔該晒", "zh-Hant"],
    ["這間房子的樓層與價格是多少？", "zh-Hant"],
    ["Giá nhà này là bao nhiêu và tôi có thể đặt cọc không?", "vi"],
    ["كم سعر هذا المنزل وما هي شروط العرض؟", "ar"],
    ["قیمت این خانه چقدر است؟ می‌خواهم پیشنهاد بدهم، چگونه؟", "fa"],
    ["ਇਸ ਘਰ ਦੀ ਕੀਮਤ ਕਿੰਨੀ ਹੈ?", "pa"],
    ["इस घर की कीमत क्या है और निपटान कब होगा?", "hi"],
    ["இந்த வீட்டின் விலை என்ன?", "ta"],
    ["Πόσο κοστίζει αυτό το σπίτι;", "el"],
    ["Buongiorno, quanto costa questa casa e come posso fare un'offerta?", "it"],
    ["Hola, ¿cuánto cuesta esta casa y cómo puedo hacer una oferta?", "es"],
    ["Magkano po ang bahay na ito at paano ako mag-alok?", "tl"],
    ["이 집의 가격은 얼마입니까?", "ko"]
  ])("%s -> %s", (text, lang) => {
    const d = detectLanguage(text);
    expect(d.lang).toBe(lang);
    expect(d.confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE);
  });

  it("marks Cantonese and romanised Hindi as dialects, so tone and voice can follow", () => {
    expect(detectLanguage("呢間屋嘅訂金係幾多？").dialect).toBe("yue");
    const h = detectLanguage("mujhe is ghar ka daam kitna hai, kya aap bata sakte hain");
    expect(h).toMatchObject({ lang: "hi", dialect: "romanised" });
  });

  it("is unsure about very short or empty text, and ignores links and emails", () => {
    expect(detectLanguage("ok").confidence).toBeLessThan(MIN_CONFIDENCE);
    expect(detectLanguage("1234 !!!").lang).toBe("en");
    expect(detectLanguage("https://example.com a@b.co").confidence).toBeLessThan(MIN_CONFIDENCE);
  });

  it("an English question with a foreign suburb name stays English", () => {
    expect(detectLanguage("What is the price of the house in Fortitude Valley?").lang).toBe("en");
  });
});

describe("chooseReplyLanguage", () => {
  const sure = { lang: "vi" as const, confidence: 0.9 };
  const unsure = { lang: "en" as const, confidence: 0.3 };
  it("a language the person chose always wins", () => expect(chooseReplyLanguage({ chosen: "ko", detected: sure })).toBe("ko"));
  it("in auto mode a confident reading wins", () => expect(chooseReplyLanguage({ lastDetected: "es", detected: sure })).toBe("vi"));
  it("a short message keeps the last language", () => expect(chooseReplyLanguage({ lastDetected: "es", detected: unsure })).toBe("es"));
  it("with nothing known it is English", () => expect(chooseReplyLanguage({ detected: unsure })).toBe("en"));
});
