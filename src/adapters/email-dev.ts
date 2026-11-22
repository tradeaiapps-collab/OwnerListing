import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isEmailAddress } from "../domain/messaging-settings";
import { failed } from "./messaging";
import type { EmailPort } from "./email";

export const DEV_MAIL_DIR = ".dev-mail";

/**
 * Development only (EMAIL_DELIVERY=dev_file, never in production): each email is written to .dev-mail/ as an .html file you can open
 * in a browser, plus a .txt with the plain part, and one line goes to the console. Nothing leaves the machine.
 */
export function createDevFileEmail(dir: string = DEV_MAIL_DIR, log: (line: string) => void = l => console.warn(l), now: () => Date = () => new Date()): EmailPort {
  let n = 0;
  return {
    configured: true,
    async send(msg) {
      if (!isEmailAddress(msg.to)) return failed("invalid_recipient", false);
      const stamp = now().toISOString().replace(/[:.]/g, "-");
      const base = `${stamp}-${String(++n).padStart(3, "0")}`;
      const header = `To: ${msg.to}\nSubject: ${msg.subject}\n\n`;
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, `${base}.txt`), header + msg.text);
        if (msg.html !== undefined) await writeFile(join(dir, `${base}.html`), msg.html);
      } catch {
        return failed("unknown", false);
      }
      log(`[email] DEV ONLY, not sent. "${msg.subject}" to ${msg.to}: ${join(dir, `${base}.${msg.html !== undefined ? "html" : "txt"}`)}`);
      return { status: "sent", providerRef: `dev_file:${base}` };
    }
  };
}

/** The dev writer is used only when asked for and never in production. */
export function devFileEmailWanted(env: Readonly<Record<string, string | undefined>>): boolean {
  return env["EMAIL_DELIVERY"] === "dev_file" && env["NODE_ENV"] !== "production";
}
