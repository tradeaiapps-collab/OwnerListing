import { idCheckFromEnv } from "../adapters/id-check";
import { malwareScannerFromEnv } from "../adapters/malware-scan";
import { objectStorageFromEnv } from "../adapters/object-storage";
import { smsFromEnv } from "../adapters/sms";
import { secretUsable } from "../domain/phone-verification";
import { getDb } from "./context";
import { idImagesReady, type IdImageDeps } from "./id-image";
import { createPgIdImageStore } from "./id-image-db";
import { createPgIdStore, createPgPhoneStore } from "./phone-verification-db";

/** Both ports fail closed until a provider is wired in and its settings exist. */
export function getPhoneDeps() {
  return { store: createPgPhoneStore(getDb()), sms: smsFromEnv(process.env), secret: process.env["SMS_CODE_SECRET"] };
}
export function getIdDeps() {
  return { store: createPgIdStore(getDb()), port: idCheckFromEnv(process.env) };
}
const idImageConfig = () => ({
  storage: objectStorageFromEnv(process.env), scanner: malwareScannerFromEnv(process.env),
  key: process.env["ID_IMAGE_KEY"], retentionSecret: process.env["ID_RETENTION_CRON_SECRET"]
});
/** In-house ID photos: storage (with delete), malware scanner, ID_IMAGE_KEY and ID_RETENTION_CRON_SECRET must all be set, or nothing is collected. */
export function getIdImageDeps(): IdImageDeps {
  return { store: createPgIdImageStore(getDb()), ...idImageConfig() };
}
/** Derived from config, never a constant: false until every piece idImagesReady needs is set. Does not touch the database. */
export function idImagesAvailable(): boolean {
  return idImagesReady(idImageConfig());
}
/** What the verification page may offer. Booleans only. */
export function verificationAvailability() {
  return {
    phone: smsFromEnv(process.env).configured && secretUsable(process.env["SMS_CODE_SECRET"]), id: idCheckFromEnv(process.env).configured,
    idImages: idImagesAvailable()
  };
}
