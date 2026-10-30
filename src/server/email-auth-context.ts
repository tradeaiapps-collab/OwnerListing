import { readBrand } from "../config/brand";
import type { SessionEnv } from "./auth/config";
import { getDb } from "./context";
import { localDevServer } from "./dev-login";
import type { EmailAuthDeps } from "./email-auth";
import { maskEmail } from "../domain/admin-moderation";
import { EMAIL_AUTH_RATE } from "../domain/email-auth";
import { getEmailPort } from "./messaging";
import { notifyAdmins } from "./notify";

/** Runtime wiring for email sign-in: database, the email settings in force now, and (on a developer's own machine) the console link. */
export async function getEmailAuthDeps(auth: SessionEnv, template: string): Promise<EmailAuthDeps> {
  const db = getDb();
  return {
    db, secret: auth.secret, appUrl: auth.appUrl, brand: readBrand().name,
    email: await getEmailPort(db, process.env, template),
    onLockout: email => void notifyAdmins(db, "sign_in_lockout",
      `The account address ${maskEmail(email)} went over the failed sign-in limit (${EMAIL_AUTH_RATE.login.perEmail} tries in ${EMAIL_AUTH_RATE.login.windowMs / 60_000} minutes). Sign-in for it is paused until the window ends. Further alerts are held for the rest of this window.`),
    ...(localDevServer() ? { devLink: (purpose: "signup" | "reset", link: string) => console.warn(`[email-auth] DEV ONLY, email is not set up. ${purpose} link: ${link}`) } : {})
  };
}
