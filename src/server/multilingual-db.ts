import { randomUUID } from "node:crypto";
import { isChatLang } from "../domain/multilingual";
import type { MultilingualDeps, TranslateServiceDeps } from "../domain/multilingual-service";
import { getAiEngine } from "./ai";
import { getDb } from "./context";
import type { Queryable } from "./db";
import { getEnquiryDeps } from "./enquiry-db";

// Constant SQL; user input only travels as bound parameters.
export function createPgMultilingual(db: Queryable, engine: MultilingualDeps["engine"]): MultilingualDeps {
  return {
    engine,
    prefs: {
      async get(userId) {
        const r = (await db.query("SELECT chat_language, last_detected_language FROM user_preference WHERE user_id = $1::uuid", [userId])).rows[0];
        return { chosen: isChatLang(r?.["chat_language"]) ? r["chat_language"] : undefined, lastDetected: isChatLang(r?.["last_detected_language"]) ? r["last_detected_language"] : undefined };
      },
      async setChosen(userId, lang) {
        await db.query(
          `INSERT INTO user_preference (user_id, chat_language, updated_at) VALUES ($1::uuid, $2, now())
           ON CONFLICT (user_id) DO UPDATE SET chat_language = EXCLUDED.chat_language, updated_at = now()`, [userId, lang ?? null]);
      },
      async setDetected(userId, lang) {
        await db.query(
          `INSERT INTO user_preference (user_id, last_detected_language) VALUES ($1::uuid, $2)
           ON CONFLICT (user_id) DO UPDATE SET last_detected_language = EXCLUDED.last_detected_language`, [userId, lang]);
      }
    },
    translations: {
      async find(kind, refId, locale) {
        const r = await db.query("SELECT text FROM ml_translation WHERE kind = $1 AND ref_id = $2::uuid AND locale = $3", [kind, refId, locale]);
        return r.rows[0] ? String(r.rows[0]["text"]) : undefined;
      },
      async add(t) {
        await db.query(
          `INSERT INTO ml_translation (id, kind, ref_id, locale, text, created_at) VALUES ($1::uuid,$2,$3::uuid,$4,$5,$6::timestamptz)
           ON CONFLICT (kind, ref_id, locale) DO NOTHING`, [t.id, t.kind, t.refId, t.locale, t.text, t.createdAt]);
      }
    }
  };
}

export function getMultilingualDeps(): MultilingualDeps {
  return createPgMultilingual(getDb(), getAiEngine);
}

export function getTranslateServiceDeps(): TranslateServiceDeps {
  return { enquiry: { ...getEnquiryDeps(), newId: () => randomUUID() }, ml: getMultilingualDeps() };
}
