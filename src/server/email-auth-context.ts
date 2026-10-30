import { readBrand } from "../config/brand";
import type { SessionEnv } from "./auth/config";
import { getDb } from "./context";
import { localDevServer } from "./dev-login";
import type { EmailAuthDeps } from "./email-auth";
import { getEmailPort } from "./messaging";

/** Runtime wiring for email sign-in: database, the email settings in force now, and (on a developer's own machine) the console link. */
export async function getEmailAuthDeps(auth: SessionEnv, template: string): Promise<EmailAuthDeps> {
  const db = getDb();
  return {
    db, secret: auth.secret, appUrl: auth.appUrl, brand: readBrand().name,
    email: await getEmailPort(db, process.env, template),
    ...(localDevServer() ? { devLink: (purpose: "signup" | "reset", link: string) => console.warn(`[email-auth] DEV ONLY, email is not set up. ${purpose} link: ${link}`) } : {})
  };
}
