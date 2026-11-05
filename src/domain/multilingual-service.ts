import { isEngineUsable, type AiEnginePort } from "./ai-engine";
import { participantEnquiry, type EnquiryDeps } from "./enquiry-service";
import { chooseReplyLanguage, detectLanguage, MIN_CONFIDENCE, type ChatLang, type Detected } from "./language-detect";
import type { Actor, Failure, Result } from "./listing-service";
import { withinLimit } from "./rate-limit";
import { CHAT_LANGUAGES, DOCUMENT_KINDS, documentNotice, englishQuestionFor, isChatLang, languageInfo, MAX_DOCUMENT_CHARS, PHRASES, translateText, type DocumentKind } from "./multilingual";

export type TranslationKind = "turn_answer" | "turn_question" | "message";
export interface LanguagePrefs { chosen?: ChatLang | undefined; lastDetected?: ChatLang | undefined }
export interface MultilingualDeps {
  /** The self-hosted engine, or the rules-only engine when AI is off (then nothing is translated). */
  engine: () => Promise<AiEnginePort>;
  prefs: {
    get(userId: string): Promise<LanguagePrefs>;
    /** undefined = detect from what they write. */
    setChosen(userId: string, lang: ChatLang | undefined): Promise<void>;
    setDetected(userId: string, lang: ChatLang): Promise<void>;
  };
  translations: {
    find(kind: TranslationKind, refId: string, locale: ChatLang): Promise<string | undefined>;
    /** Insert only; a second insert for the same (kind, refId, locale) is ignored. */
    add(t: { id: string; kind: TranslationKind; refId: string; locale: ChatLang; text: string; createdAt: string }): Promise<void>;
  };
}

/** Per person per hour. Translation runs on our own GPU, so it is limited like AI drafts. */
export const TRANSLATE_RATE = { windowMs: 60 * 60 * 1000, perUser: 60 } as const;
/** New translations done while loading one thread; the rest arrive on the next load or by tapping Translate. */
export const LAZY_TRANSLATIONS_PER_LOAD = 4;

const fail = (code: Failure["code"], message: string): Failure => ({ ok: false, code, message });

/** What the person sees beside an English answer that was translated for them. */
export interface Localized { locale: ChatLang; text: string; mode: "translated" | "english_fallback"; note: string; rtl: boolean }

export function parsePrefsInput(body: unknown): Result<{ language: ChatLang | "auto" }> {
  const v = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["language"] : undefined;
  if (v === "auto") return { ok: true, value: { language: "auto" } };
  if (!isChatLang(v)) return fail("invalid", `Choose "auto" or one of: ${CHAT_LANGUAGES.map(l => l.code).join(", ")}.`);
  return { ok: true, value: { language: v } };
}

export async function setLanguage(deps: MultilingualDeps, userId: string, language: ChatLang | "auto"): Promise<void> {
  await deps.prefs.setChosen(userId, language === "auto" ? undefined : language);
}

export async function getLanguage(deps: MultilingualDeps, userId: string) {
  const p = await deps.prefs.get(userId);
  return { language: p.chosen ?? "auto", lastDetected: p.lastDetected ?? null, effective: p.chosen ?? p.lastDetected ?? "en", options: CHAT_LANGUAGES.map(l => ({ code: l.code, name: l.name, rtl: l.rtl, speech: l.speech })) };
}

/** Names that must stay as written in a translation: the listing's title, street address and suburb. */
export interface KeepNames { title?: string | undefined; address?: string | undefined; suburb?: string | undefined }
const keepList = (k: KeepNames) => [k.title, k.address, k.suburb].filter((x): x is string => typeof x === "string" && x.length > 2);

async function usableEngine(deps: MultilingualDeps): Promise<AiEnginePort | undefined> {
  try { const e = await deps.engine(); return isEngineUsable(e) ? e : undefined; } catch { return undefined; }
}

export interface Prepared { reply: ChatLang; detected: Detected; /** English wording to match topics against, for a question written in another language. */ matchAs?: string | undefined }

/**
 * Reads the question's language, decides what to answer in (a saved choice wins; otherwise the language they wrote in),
 * remembers it, and finds English wording to match the question against. Never throws: any failure means English.
 */
export async function prepareQuestion(deps: MultilingualDeps, userId: string, question: string): Promise<Prepared> {
  const detected = detectLanguage(question);
  let prefs: LanguagePrefs = {};
  try { prefs = await deps.prefs.get(userId); } catch { /* English */ }
  const reply = chooseReplyLanguage({ chosen: prefs.chosen, lastDetected: prefs.lastDetected, detected });
  if (detected.confidence >= MIN_CONFIDENCE && detected.lang !== prefs.lastDetected) await deps.prefs.setDetected(userId, detected.lang).catch(() => {});
  let matchAs: string | undefined;
  if (detected.lang !== "en" && detected.confidence >= MIN_CONFIDENCE) {
    const engine = await usableEngine(deps);
    if (engine) {
      const t = await translateText(question, { engine, from: detected.lang, to: "en", register: "faithful" }).catch(() => undefined);
      if (t?.complete) matchAs = t.text;
    }
    matchAs ??= englishQuestionFor(question)?.english;
  }
  return { reply, detected, matchAs };
}

/** Her answer in the person's language, or the English answer with a short note in their language when translation is off or fails. */
export async function localizeAnswer(deps: MultilingualDeps, turn: { id: string; answer: string }, reply: ChatLang, names: KeepNames, now: string, newId: () => string): Promise<Localized | undefined> {
  if (reply === "en") return undefined;
  const info = languageInfo(reply); const ph = PHRASES[reply];
  const cached = await deps.translations.find("turn_answer", turn.id, reply).catch(() => undefined);
  if (cached) return { locale: reply, text: cached, mode: "translated", note: ph.machineNote, rtl: info.rtl };
  const engine = await usableEngine(deps);
  const t = engine ? await translateText(turn.answer, { engine, from: "en", to: reply, register: "assistant", keep: keepList(names) }).catch(() => undefined) : undefined;
  if (!t?.complete) return { locale: reply, text: ph.englishBelow, mode: "english_fallback", note: ph.englishBelow, rtl: info.rtl };
  await deps.translations.add({ id: newId(), kind: "turn_answer", refId: turn.id, locale: reply, text: t.text, createdAt: now }).catch(() => {});
  return { locale: reply, text: t.text, mode: "translated", note: ph.machineNote, rtl: info.rtl };
}

export interface TurnTranslations { question?: string; answer?: string }
export interface ThreadLocalization {
  locale: ChatLang; rtl: boolean; welcome: string; machineNote: string; engineOn: boolean;
  turns: Record<string, TurnTranslations>;
}

/** The viewer's language for the thread: what they chose, else the language last seen from them, else English. English means nothing is translated. */
export async function localizeThread(
  deps: MultilingualDeps, userId: string, personaName: string, turns: readonly { id: string; question: string; answer: string; language?: ChatLang | undefined }[],
  names: KeepNames, now: string, newId: () => string
): Promise<ThreadLocalization> {
  const prefs = await deps.prefs.get(userId).catch((): LanguagePrefs => ({}));
  const locale: ChatLang = prefs.chosen ?? prefs.lastDetected ?? "en";
  const info = languageInfo(locale);
  const out: ThreadLocalization = { locale, rtl: info.rtl, welcome: PHRASES[locale].welcome(personaName), machineNote: PHRASES[locale].machineNote, engineOn: false, turns: {} };
  if (locale === "en") return out;
  const engine = await usableEngine(deps);
  out.engineOn = engine !== undefined;
  let budget = LAZY_TRANSLATIONS_PER_LOAD;
  // Newest first, so a long thread shows the recent exchange in the person's language straight away.
  for (const t of [...turns].reverse()) {
    const entry: TurnTranslations = {};
    const srcQ = t.language ?? detectLanguage(t.question).lang;
    for (const [kind, text, from] of [["turn_answer", t.answer, "en"], ["turn_question", t.question, srcQ]] as const) {
      if (from === locale) continue;
      let found = await deps.translations.find(kind, t.id, locale).catch(() => undefined);
      if (!found && engine && budget > 0) {
        budget--;
        const r = await translateText(text, { engine, from, to: locale, register: kind === "turn_answer" ? "assistant" : "faithful", keep: keepList(names) }).catch(() => undefined);
        if (r?.complete) { found = r.text; await deps.translations.add({ id: newId(), kind, refId: t.id, locale, text: found, createdAt: now }).catch(() => {}); }
      }
      if (found) entry[kind === "turn_answer" ? "answer" : "question"] = found;
    }
    if (entry.answer !== undefined || entry.question !== undefined) out.turns[t.id] = entry;
  }
  return out;
}

// ---- Translating a person's message, and documents ----
export interface TranslateServiceDeps { enquiry: EnquiryDeps; ml: MultilingualDeps }

async function guardedEngine(deps: TranslateServiceDeps, actor: Actor): Promise<Result<AiEnginePort>> {
  let hits: number | undefined;
  try { hits = await deps.enquiry.countHit(`ml-translate:${actor.userId}`, TRANSLATE_RATE.windowMs); } catch { hits = undefined; }
  if (!withinLimit(hits, TRANSLATE_RATE.perUser)) return fail("rate_limited", "You've translated a lot this hour. Try again later.");
  const engine = await usableEngine(deps.ml);
  return engine ? { ok: true, value: engine } : fail("unavailable", "Translation is not switched on yet. The English original still applies.");
}

async function targetFor(deps: MultilingualDeps, userId: string, asked: unknown): Promise<Result<ChatLang>> {
  if (asked !== undefined && asked !== null) return isChatLang(asked) ? { ok: true, value: asked } : fail("invalid", "Choose a supported language.");
  const p = await deps.prefs.get(userId);
  return { ok: true, value: p.chosen ?? p.lastDetected ?? "en" };
}

export interface MessageTranslation { messageId: string; from: ChatLang; to: ChatLang; text: string; machine: true; note: string; rtl: boolean; cached: boolean }

/**
 * Translates one message in a thread for a party. The original is never changed. The translation is saved once per language, so
 * the other party reading it in the same language costs nothing. Machine translated, and labelled so.
 */
export async function translateEnquiryMessage(deps: TranslateServiceDeps, actor: Actor, enquiryId: string, messageId: string, target?: unknown): Promise<Result<MessageTranslation>> {
  const p = await participantEnquiry(deps.enquiry, actor, enquiryId);
  if (!p.ok) return p;
  const msg = (await deps.enquiry.enquiries.messages(enquiryId)).find(m => m.id === messageId);
  if (!msg) return fail("not_found", "Message not found.");
  const to = await targetFor(deps.ml, actor.userId, target);
  if (!to.ok) return to;
  const from = detectLanguage(msg.body).lang;
  const base = { messageId, from, to: to.value, machine: true as const, note: PHRASES[to.value].machineNote, rtl: languageInfo(to.value).rtl };
  if (from === to.value) return { ok: true, value: { ...base, text: msg.body, cached: true } };
  const cached = await deps.ml.translations.find("message", messageId, to.value).catch(() => undefined);
  if (cached) return { ok: true, value: { ...base, text: cached, cached: true } };
  const e = await guardedEngine(deps, actor);
  if (!e.ok) return e;
  const r = await translateText(msg.body, { engine: e.value, from, to: to.value, register: "faithful" }).catch(() => undefined);
  if (!r?.complete) return fail("unavailable", "Couldn't translate that message safely. The English original still applies.");
  await deps.ml.translations.add({ id: deps.enquiry.newId(), kind: "message", refId: messageId, locale: to.value, text: r.text, createdAt: deps.enquiry.now() }).catch(() => {});
  return { ok: true, value: { ...base, text: r.text, cached: false } };
}

export interface DocumentTranslation { from: ChatLang; to: ChatLang; kind: DocumentKind; text: string; notice: string; englishPrevails: true; complete: boolean; untranslatedLines: number; rtl: boolean }

export function parseDocumentInput(body: unknown): Result<{ text: string; kind: DocumentKind; to?: unknown; from?: ChatLang }> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return fail("invalid", "Send a JSON object.");
  const b = body as Record<string, unknown>;
  const text = typeof b["text"] === "string" ? b["text"] : "";
  if (!text.trim()) return fail("invalid", "Paste the document text to translate.");
  if (text.length > MAX_DOCUMENT_CHARS) return fail("invalid", `Documents can be up to ${MAX_DOCUMENT_CHARS} characters at a time. Send long documents in parts.`);
  const kind = b["kind"] ?? "other";
  if (!(DOCUMENT_KINDS as readonly unknown[]).includes(kind)) return fail("invalid", `kind must be one of: ${DOCUMENT_KINDS.join(", ")}.`);
  if (b["from"] !== undefined && !isChatLang(b["from"])) return fail("invalid", "Choose a supported source language.");
  return { ok: true, value: { text, kind: kind as DocumentKind, to: b["to"], ...(isChatLang(b["from"]) ? { from: b["from"] } : {}) } };
}

/**
 * Translates an offer, contract or inspection report for a party, keeping its layout and every number, amount and contact detail exact.
 * Nothing is stored (these documents hold personal and financial details). Always carries the notice that English applies.
 */
export async function translateDocument(deps: TranslateServiceDeps, actor: Actor, enquiryId: string, input: { text: string; kind: DocumentKind; to?: unknown; from?: ChatLang | undefined }): Promise<Result<DocumentTranslation>> {
  const p = await participantEnquiry(deps.enquiry, actor, enquiryId);
  if (!p.ok) return p;
  const to = await targetFor(deps.ml, actor.userId, input.to);
  if (!to.ok) return to;
  const from = input.from ?? detectLanguage(input.text).lang;
  const e = await guardedEngine(deps, actor);
  if (!e.ok) return e;
  if (from === to.value) return fail("invalid", "That document is already in the language you chose.");
  const r = await translateText(input.text, { engine: e.value, from, to: to.value, register: "faithful" });
  await deps.enquiry.appendAudit({
    id: deps.enquiry.newId(), occurredAt: deps.enquiry.now(), actorType: "user", actorId: actor.userId, aggregateType: "enquiry", aggregateId: enquiryId,
    eventType: "enquiry.document_translated", correlationId: deps.enquiry.newId(),
    payload: { kind: input.kind, from, to: to.value, chars: input.text.length, complete: r.complete }
  });
  return {
    ok: true,
    value: { from, to: to.value, kind: input.kind, text: r.text, notice: documentNotice(to.value), englishPrevails: true, complete: r.complete, untranslatedLines: r.totalSegments - r.translatedSegments, rtl: languageInfo(to.value).rtl }
  };
}

/** In-memory stores for tests. */
export function createInMemoryMultilingual(engine: AiEnginePort): MultilingualDeps & { prefsByUser: Map<string, LanguagePrefs>; rows: { kind: TranslationKind; refId: string; locale: ChatLang; text: string }[] } {
  const prefsByUser = new Map<string, LanguagePrefs>();
  const rows: { kind: TranslationKind; refId: string; locale: ChatLang; text: string }[] = [];
  return {
    prefsByUser, rows, engine: async () => engine,
    prefs: {
      async get(u) { return { ...(prefsByUser.get(u) ?? {}) }; },
      async setChosen(u, l) { prefsByUser.set(u, { ...(prefsByUser.get(u) ?? {}), chosen: l }); },
      async setDetected(u, l) { prefsByUser.set(u, { ...(prefsByUser.get(u) ?? {}), lastDetected: l }); }
    },
    translations: {
      async find(kind, refId, locale) { return rows.find(r => r.kind === kind && r.refId === refId && r.locale === locale)?.text; },
      async add(t) { if (!rows.some(r => r.kind === t.kind && r.refId === t.refId && r.locale === t.locale)) rows.push({ kind: t.kind, refId: t.refId, locale: t.locale, text: t.text }); }
    }
  };
}
