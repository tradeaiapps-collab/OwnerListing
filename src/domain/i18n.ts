export interface LocaleDef { code: string; name: string; rtl: boolean }

/** Languages we plan to support. A language is switched on by an admin only after a human-reviewed catalogue exists. */
export const LOCALES: readonly LocaleDef[] = [
  { code: "en-AU", name: "English", rtl: false },
  { code: "fa", name: "فارسی", rtl: true },
  { code: "ar", name: "العربية", rtl: true },
  { code: "zh-Hans", name: "简体中文", rtl: false },
  { code: "zh-Hant", name: "繁體中文", rtl: false },
  { code: "vi", name: "Tiếng Việt", rtl: false },
  { code: "hi", name: "हिन्दी", rtl: false },
  { code: "ko", name: "한국어", rtl: false },
  { code: "el", name: "Ελληνικά", rtl: false },
  { code: "it", name: "Italiano", rtl: false },
  { code: "es", name: "Español", rtl: false }
];

export const DEFAULT_LOCALE = "en-AU";
export type Catalog = Readonly<Record<string, string>>;

export function isRtl(code: string): boolean {
  return LOCALES.find(l => l.code === code)?.rtl ?? false;
}

/** The user's choice, but only if an admin has enabled it. Otherwise English. */
export function resolveLocale(requested: string | undefined, enabled: readonly string[]): string {
  return requested !== undefined && enabled.includes(requested) ? requested : DEFAULT_LOCALE;
}

/** Looks up a string: exact language, then base language, then English. Never returns blank. */
export function translate(catalogs: Readonly<Record<string, Catalog>>, locale: string, key: string): string {
  const base = locale.split("-")[0] ?? locale;
  return catalogs[locale]?.[key] ?? catalogs[base]?.[key] ?? catalogs[DEFAULT_LOCALE]?.[key] ?? key;
}

/** Translations are for understanding only. Legal documents, disclosures and terms stay in English. */
export const ENGLISH_PREVAILS_NOTICE =
  "This translation is provided for convenience only. If it differs from the English version, the English version applies.";
