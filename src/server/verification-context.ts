import { idCheckFromEnv } from "../adapters/id-check";
import { smsFromEnv } from "../adapters/sms";
import { secretUsable } from "../domain/phone-verification";
import { getDb } from "./context";
import { createPgIdStore, createPgPhoneStore } from "./phone-verification-db";

/** Both ports fail closed until a provider is wired in and its settings exist. */
export function getPhoneDeps() {
  return { store: createPgPhoneStore(getDb()), sms: smsFromEnv(process.env), secret: process.env["SMS_CODE_SECRET"] };
}
export function getIdDeps() {
  return { store: createPgIdStore(getDb()), port: idCheckFromEnv(process.env) };
}
/** What the verification page may offer. Booleans only. */
export function verificationAvailability() {
  return { phone: smsFromEnv(process.env).configured && secretUsable(process.env["SMS_CODE_SECRET"]), id: idCheckFromEnv(process.env).configured };
}
