import { idCheckFromEnv } from "../adapters/id-check";
import { secretUsable } from "../domain/phone-verification";
import { getDb } from "./context";
import { getSmsPort } from "./messaging";
import { createPgIdStore, createPgPhoneStore } from "./phone-verification-db";

/** Both ports fail closed until a provider is wired in and its settings exist. */
export async function getPhoneDeps() {
  return { store: createPgPhoneStore(getDb()), sms: await getSmsPort(getDb(), process.env, "phone_code"), secret: process.env["SMS_CODE_SECRET"] };
}
export function getIdDeps() {
  return { store: createPgIdStore(getDb()), port: idCheckFromEnv(process.env) };
}
/** What the verification page may offer. Booleans only. */
export async function verificationAvailability() {
  return { phone: (await getSmsPort(getDb(), process.env, "phone_code")).configured && secretUsable(process.env["SMS_CODE_SECRET"]), id: idCheckFromEnv(process.env).configured };
}
